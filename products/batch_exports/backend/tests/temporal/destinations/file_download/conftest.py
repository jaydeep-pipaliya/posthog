import os
import uuid

import pytest

import aioboto3
import pytest_asyncio

from products.batch_exports.backend.tests.temporal.utils.s3 import delete_all_from_s3

TEST_BUCKET_NAME = os.getenv("S3_TEST_BUCKET", "test-file-downloads")


@pytest.fixture
def bucket_name() -> str:
    return TEST_BUCKET_NAME


@pytest.fixture
def s3_key_prefix() -> str:
    return f"batch-exports/{uuid.uuid4()}"


@pytest.fixture
def compression(request) -> str | None:
    try:
        return request.param
    except AttributeError:
        return None


@pytest.fixture
def file_format(request) -> str:
    try:
        return request.param
    except AttributeError:
        return "Parquet"


@pytest_asyncio.fixture
async def s3_client(bucket_name, s3_key_prefix):
    """Manage an S3 client to interact with an S3 bucket.

    Yields the client after assuming the test bucket exists. Upon resuming, we delete
    the contents of the bucket under the key prefix we are testing.
    """
    async with aioboto3.Session().client("s3") as s3_client:
        yield s3_client

        await delete_all_from_s3(s3_client, bucket_name, key_prefix=s3_key_prefix)
