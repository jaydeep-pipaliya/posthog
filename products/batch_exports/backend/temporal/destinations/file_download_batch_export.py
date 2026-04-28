import re
import json
import typing
import asyncio
import datetime as dt
import dataclasses

from django.conf import settings

import aioboto3
from temporalio import activity, workflow
from temporalio.common import RetryPolicy

from posthog.batch_exports.models import BatchExportFileDownload
from posthog.temporal.common.base import PostHogWorkflow
from posthog.temporal.common.heartbeat import Heartbeater
from posthog.temporal.common.logger import get_logger, get_write_only_logger

from products.batch_exports.backend.service import BatchExportInsertInputs, FileDownloadBatchExportInputs
from products.batch_exports.backend.temporal.batch_exports import (
    OverBillingLimitError,
    StartBatchExportRunInputs,
    start_batch_export_run,
)
from products.batch_exports.backend.temporal.destinations.s3_batch_export import (
    S3BatchExportResult,
    S3InsertInputs,
    insert_into_s3_activity_from_stage,
    s3_default_fields,
)
from products.batch_exports.backend.temporal.pipeline.entrypoint import execute_batch_export_using_internal_stage
from products.batch_exports.backend.temporal.pipeline.internal_stage import (
    BatchExportInsertIntoInternalStageInputs,
    insert_into_internal_stage_activity,
)
from products.batch_exports.backend.temporal.pipeline.types import BatchExportResult
from products.batch_exports.backend.temporal.utils import handle_non_retryable_errors

LOGGER = get_write_only_logger(__name__)
EXTERNAL_LOGGER = get_logger()
FILE_DOWNLOAD_PREFIX = "batch-exports/{batch_export_id}/{{data_interval_start}}-{{data_interval_end}}"

NON_RETRYABLE_ERROR_TYPES = ()


class Credentials(typing.NamedTuple):
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: str


async def _get_temporary_credentials_for_multipart_upload(
    bucket: str, prefix: str, /, role: str, duration: int = 3600
) -> Credentials:
    """Get temporary AWS credentials for a multipart upload to keys under prefix."""
    creds = await _get_temporary_credentials_for_bucket_prefix(
        bucket,
        prefix,
        role=role,
        session_name="batch-exports-file-download-multipart-upload",
        actions=["s3:PutObject", "s3:AbortMultiPartUpload"],
        duration=duration,
    )
    return creds


async def _get_temporary_credentials_to_head_object(
    bucket: str, prefix: str, /, role: str, duration: int = 300
) -> Credentials:
    """Get temporary AWS credentials to generate pre-signed URLs for keys under prefix."""
    creds = await _get_temporary_credentials_for_bucket_prefix(
        bucket,
        prefix,
        role=role,
        session_name="batch-exports-file-download-generate-pre-signed-url",
        actions=["s3:HeadObject"],
        duration=duration,
    )
    return creds


async def _get_temporary_credentials_for_bucket_prefix(
    bucket: str, prefix: str, /, role: str, session_name: str, actions: list[str], duration: int = 3600
) -> Credentials:
    """Get temporary credentials scoped to operate only on the bucket's prefix.

    The credentials should be limited to a set of actions using the `actions` argument.
    Thus, this should not be called directly, rather call
    `_get_temporary_credentials_for_multipart_upload` or
    `_get_temporary_credentials_to_head_object` as needed.
    """
    session = aioboto3.Session()

    async with session.client("sts") as sts:
        identity = await sts.get_caller_identity()
        response = await sts.assume_role(
            RoleArn=f"arn:aws:iam::{identity['Account']}:role/{role}",
            RoleSessionName=session_name,
            DurationSeconds=duration,
            Policy=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Action": actions,
                            "Resource": f"arn:aws:s3:::{bucket}/{prefix}/*",
                        },
                    ],
                }
            ),
        )

    return Credentials(
        response["Credentials"]["AccessKeyId"],
        response["Credentials"]["SecretAccessKey"],
        response["Credentials"]["SessionToken"],
    )


def parse_expiration(expiration: str | None) -> dt.datetime | None:
    """Parse an expiration string returned by AWS to extract the expiry-date."""
    if expiration is None:
        return None

    match = re.search(r'expiry-date="([^"]+)"', expiration)

    if match is None:
        return None

    date_str = match.group(1)
    expiry_date = dt.datetime.strptime(date_str, "%a, %d %b %Y %H:%M:%S %Z").replace(tzinfo=dt.UTC)

    return expiry_date


@dataclasses.dataclass
class S3Bucket:
    name: str
    region: str


@dataclasses.dataclass
class GenerateFileDownloadsInputs:
    team_id: int
    batch_export_id: str
    s3_bucket: S3Bucket
    aws_role: str
    keys: tuple[str, ...]


FileDownloadIds = list[str]


@activity.defn
@handle_non_retryable_errors(NON_RETRYABLE_ERROR_TYPES)
async def generate_file_downloads(inputs: GenerateFileDownloadsInputs) -> FileDownloadIds:
    """Generate file downloads for given keys.

    The temporary credentials used to sign the download URLs are configured to last for
    `inputs.expires_in_seconds`, same as the download URLs themselves. In other words,
    both the credentials and the URL will expire around the same time. There is a time
    window in between generating the credentials and generating the URLs, so the
    credentials are always the ones who expire first. However, URLs should be generated
    relatively quickly, so we expect the time window to be very small to notice.
    """
    existing = [
        file_download
        async for file_download in BatchExportFileDownload.objects.filter(
            team_id=inputs.team_id, key__in=inputs.keys
        ).all()
    ]
    file_downloads = [file_download.id for file_download in existing]
    keys = set(inputs.keys) - {file_download.key for file_download in existing}

    if not keys:
        # There is nothing to do, maybe we completed everything in a previous attempt.
        return file_downloads

    async with Heartbeater():
        prefix = FILE_DOWNLOAD_PREFIX.format(batch_export_id=inputs.batch_export_id)
        credentials = await _get_temporary_credentials_to_head_object(
            inputs.s3_bucket.name,
            prefix,
            role=inputs.aws_role,
        )
        session = aioboto3.Session(
            aws_access_key_id=credentials.aws_access_key_id,
            aws_secret_access_key=credentials.aws_secret_access_key,
            aws_session_token=credentials.aws_session_token,
        )

        async with session.client("s3") as s3:

            async def create_file_download(key: str):
                object = await s3.head_object(Bucket=inputs.s3_bucket.name, Key=key)

                expires_at = parse_expiration(object.get("Expiration"))
                file_download = await BatchExportFileDownload.objects.acreate(
                    team_id=inputs.team_id, key=key, expires_at=expires_at, batch_export_id=inputs.batch_export_id
                )
                file_downloads.append(str(file_download.id))

        async with asyncio.TaskGroup() as tg:
            for key in keys:
                tg.create_task(create_file_download(key))

    return file_downloads


@dataclasses.dataclass
class ExportInputs:
    batch_export: BatchExportInsertInputs
    s3_bucket: S3Bucket
    aws_role: str
    compression: str | None = None
    file_format: str = "JSONLines"
    max_file_size_mb: int | None = None


@activity.defn
@handle_non_retryable_errors(NON_RETRYABLE_ERROR_TYPES)
async def export_to_file_download_bucket_with_temporay_credentials(inputs: ExportInputs):
    """Export to S3 file download bucket using temporary AWS credentials.

    After obtaining the credentials, we simply run the same function as an S3 batch
    export targeting our own file download bucket.
    """
    prefix = FILE_DOWNLOAD_PREFIX.format(batch_export_id=inputs.batch_export.batch_export_id)
    # `data_interval_start` cannot be `None`, but `BatchExportInsertInputs` supports this
    # TODO: Figure out if we want to support beginning of time.
    assert inputs.batch_export.data_interval_start
    interval = dt.datetime.fromisoformat(inputs.batch_export.data_interval_end) - dt.datetime.fromisoformat(
        inputs.batch_export.data_interval_start
    )

    # We want Temporal to time us out before the credentials expire.
    # So, we add a little additional time on the credentials as a grace period.
    grace_period = 0.1
    credentials = await _get_temporary_credentials_for_multipart_upload(
        inputs.s3_bucket.name, prefix, role=inputs.aws_role, duration=int(interval.total_seconds() * (1 + grace_period))
    )

    s3_insert_inputs = S3InsertInputs(
        bucket_name=inputs.s3_bucket.name,
        region=inputs.s3_bucket.region,
        prefix=prefix,
        compression=inputs.compression,
        file_format=inputs.file_format,
        max_file_size_mb=inputs.max_file_size_mb,
        aws_access_key_id=credentials.aws_access_key_id,
        aws_secret_access_key=credentials.aws_secret_access_key,
        aws_session_token=credentials.aws_session_token,
        data_interval_start=inputs.batch_export.data_interval_start,
        data_interval_end=inputs.batch_export.data_interval_end,
        exclude_events=inputs.batch_export.exclude_events,
        include_events=inputs.batch_export.include_events,
        team_id=inputs.batch_export.team_id,
        run_id=inputs.batch_export.run_id,
        stage_folder=inputs.batch_export.stage_folder,
        batch_export_model=inputs.batch_export.batch_export_model,
        batch_export_id=inputs.batch_export.batch_export_id,
        destination_default_fields=s3_default_fields(),
    )
    result = await insert_into_s3_activity_from_stage(s3_insert_inputs)

    return result


@dataclasses.dataclass
class FileDownloadBatchExportResult(BatchExportResult):
    file_downloads: FileDownloadIds = dataclasses.field(default_factory=list)


@workflow.defn(name="file-download-export", failure_exception_types=[workflow.NondeterminismError])
class FileDownloadBatchExportWorkflow(PostHogWorkflow):
    """Workflow to generate files for download from an S3 bucket.

    The workflow works by executing what is essentially an S3 batch export, but
    targeting one of our own buckets. Afterwards, the workflow generates pre-signed
    URLs so that the files in our own bucket can be downloaded by anybody with the URL.
    These URLs are stored in our database so they can be served to users of PostHog.
    """

    @staticmethod
    def parse_inputs(inputs: list[str]) -> FileDownloadBatchExportInputs:
        """Parse inputs from the management command CLI."""
        loaded = json.loads(inputs[0])
        return FileDownloadBatchExportInputs(**loaded)

    @workflow.run
    async def run(self, inputs: FileDownloadBatchExportInputs) -> FileDownloadBatchExportResult:
        """Run the workflow.

        Starts off with the same activities as an S3 batch export, but with some changes
        to utilize our own buckets and credentials.

        Ends with generating the necessary pre-signed URLs for downloading the files
        exported to S3.
        """
        data_interval_end_dt = dt.datetime.fromisoformat(inputs.data_interval_end)
        data_interval_start_dt = dt.datetime.fromisoformat(inputs.data_interval_start)
        interval_delta = data_interval_end_dt - data_interval_start_dt

        start_batch_export_run_inputs = StartBatchExportRunInputs(
            team_id=inputs.team_id,
            batch_export_id=inputs.batch_export_id,
            data_interval_start=data_interval_start_dt.isoformat(),
            data_interval_end=data_interval_end_dt.isoformat(),
            exclude_events=inputs.exclude_events,
            include_events=inputs.include_events,
            backfill_id=inputs.backfill_details.backfill_id if inputs.backfill_details else None,
        )
        try:
            run_id = await workflow.execute_activity(
                start_batch_export_run,
                start_batch_export_run_inputs,
                start_to_close_timeout=dt.timedelta(minutes=5),
                retry_policy=RetryPolicy(
                    initial_interval=dt.timedelta(seconds=10),
                    maximum_interval=dt.timedelta(seconds=60),
                    maximum_attempts=0,
                    non_retryable_error_types=["NotNullViolation", "IntegrityError", "OverBillingLimitError"],
                ),
            )
        except OverBillingLimitError:
            return FileDownloadBatchExportResult(records_completed=0, bytes_exported=0)

        stage_folder = await workflow.execute_activity(
            insert_into_internal_stage_activity,
            BatchExportInsertIntoInternalStageInputs(
                team_id=inputs.team_id,
                batch_export_id=inputs.batch_export_id,
                data_interval_start=data_interval_start_dt.isoformat(),
                data_interval_end=data_interval_end_dt.isoformat(),
                exclude_events=inputs.exclude_events,
                include_events=inputs.include_events,
                run_id=run_id,
                backfill_details=inputs.backfill_details,
                batch_export_model=inputs.batch_export_model,
                batch_export_schema=inputs.batch_export_schema,
                destination_default_fields=s3_default_fields(),
            ),
            start_to_close_timeout=interval_delta,
            heartbeat_timeout=dt.timedelta(seconds=180),
            retry_policy=RetryPolicy(
                initial_interval=dt.timedelta(seconds=1),
                maximum_interval=interval_delta,
                maximum_attempts=0,
                non_retryable_error_types=["InvalidFilterError"],
            ),
        )

        export_inputs = ExportInputs(
            batch_export=BatchExportInsertInputs(
                team_id=inputs.team_id,
                run_id=run_id,
                stage_folder=stage_folder,
                batch_export_model=inputs.batch_export_model,
                batch_export_id=inputs.batch_export_id,
                exclude_events=inputs.exclude_events,
                include_events=inputs.include_events,
                data_interval_start=data_interval_start_dt.isoformat(),
                data_interval_end=data_interval_end_dt.isoformat(),
            ),
            s3_bucket=S3Bucket(
                name=settings.BATCH_EXPORTS_FILE_DOWNLOAD_BUCKET,
                region=settings.BATCH_EXPORTS_FILE_DOWNLOAD_REGION,
            ),
            aws_role=settings.BATCH_EXPORTS_FILE_DOWNLOAD_ROLE,
            compression=inputs.compression,
            file_format=inputs.file_format,
            max_file_size_mb=inputs.max_file_size_mb,
        )
        result: S3BatchExportResult = await execute_batch_export_using_internal_stage(
            export_to_file_download_bucket_with_temporay_credentials,
            export_inputs,  # type: ignore
            interval=f"every {interval_delta.total_seconds()} seconds",
        )

        file_downloads = await workflow.execute_activity(
            generate_file_downloads,
            GenerateFileDownloadsInputs(
                team_id=inputs.team_id,
                batch_export_id=inputs.batch_export_id,
                s3_bucket=S3Bucket(
                    name=settings.BATCH_EXPORTS_FILE_DOWNLOAD_BUCKET,
                    region=settings.BATCH_EXPORTS_FILE_DOWNLOAD_REGION,
                ),
                keys=tuple(result.files_uploaded),
                aws_role=settings.BATCH_EXPORTS_FILE_DOWNLOAD_ROLE,
            ),
            start_to_close_timeout=dt.timedelta(minutes=5),
            heartbeat_timeout=dt.timedelta(seconds=10),
            retry_policy=RetryPolicy(
                initial_interval=dt.timedelta(seconds=1),
                maximum_interval=dt.timedelta(seconds=60),
                maximum_attempts=0,
            ),
        )

        return FileDownloadBatchExportResult(
            records_completed=result.records_completed,
            bytes_exported=result.bytes_exported,
            file_downloads=file_downloads,
        )
