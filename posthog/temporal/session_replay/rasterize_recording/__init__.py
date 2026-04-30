from posthog.temporal.session_replay.rasterize_recording.activities import (
    build_rasterization_input,
    finalize_rasterization,
)
from posthog.temporal.session_replay.rasterize_recording.stuck_counter import (
    bump_stuck_counter_activity,
    clear_stuck_counter_activity,
)
from posthog.temporal.session_replay.rasterize_recording.workflow import RasterizeRecordingWorkflow

WORKFLOWS = [RasterizeRecordingWorkflow]
ACTIVITIES = [
    build_rasterization_input,
    finalize_rasterization,
    bump_stuck_counter_activity,
    clear_stuck_counter_activity,
]
