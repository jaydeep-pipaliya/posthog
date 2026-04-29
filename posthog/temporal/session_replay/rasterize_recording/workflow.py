import json
import datetime as dt
from typing import Any

import temporalio.workflow as wf
from temporalio import common

from posthog.temporal.common.base import PostHogWorkflow

with wf.unsafe.imports_passed_through():
    from django.conf import settings

from .activities import build_rasterization_input, finalize_rasterization
from .types import (
    BuildRasterizationResult,
    FinalizeRasterizationInput,
    RasterizationActivityOutput,
    RasterizeRecordingInputs,
)


@wf.defn(name="rasterize-recording")
class RasterizeRecordingWorkflow(PostHogWorkflow):
    def __init__(self) -> None:
        self._phase: str = "preparing"

    @wf.query
    def get_progress(self) -> dict[str, str]:
        """Coarse-grained phase of the rasterization workflow.

        Fine-grained frame progress is reported separately via activity
        heartbeats — read those via `describe().pending_activities`.
        """
        return {"phase": self._phase}

    @staticmethod
    def parse_inputs(inputs: list[str]) -> RasterizeRecordingInputs:
        return RasterizeRecordingInputs(**json.loads(inputs[0]))

    @wf.run
    async def run(self, inputs: RasterizeRecordingInputs) -> RasterizationActivityOutput:
        retry_policy = common.RetryPolicy(maximum_attempts=3)

        self._phase = "preparing"
        prep: BuildRasterizationResult = await wf.execute_activity(
            build_rasterization_input,
            inputs.exported_asset_id,
            start_to_close_timeout=dt.timedelta(minutes=5),
            retry_policy=retry_policy,
        )

        if prep.cached_output is not None:
            self._phase = "done"
            return prep.cached_output

        assert prep.activity_input is not None  # tagged-union invariant

        self._phase = "rendering"
        # Node.js returns a plain dict across the cross-language boundary.
        raw_result: dict[str, Any] = await wf.execute_activity(
            "rasterize-recording",
            prep.activity_input.model_dump(exclude_none=True),
            task_queue=settings.RASTERIZATION_TASK_QUEUE,
            start_to_close_timeout=dt.timedelta(minutes=30),
            heartbeat_timeout=dt.timedelta(seconds=30),
            retry_policy=common.RetryPolicy(maximum_attempts=2),
        )

        result = RasterizationActivityOutput.model_validate(raw_result)

        self._phase = "finalizing"
        await wf.execute_activity(
            finalize_rasterization,
            FinalizeRasterizationInput(
                exported_asset_id=inputs.exported_asset_id,
                result=result,
                render_fingerprint=prep.render_fingerprint,
            ),
            start_to_close_timeout=dt.timedelta(minutes=2),
            retry_policy=retry_policy,
        )

        self._phase = "done"
        return result
