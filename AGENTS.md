# Project Aida instructions

## Non-negotiable video requirement: 120 fps

120 fps is the central purpose of this project. Apply this requirement to implementation, documentation, recommendations, and performance tradeoffs.

- Every video rendition must meet the 120 fps target: VOD, future live streams, all resolution and bitrate tiers, HDR versions, SDR versions, and compatibility fallbacks.
- Resolution and bitrate may change to fit bandwidth or processing capacity. Do not reduce the frame rate below 120 fps.
- 4K and HDR are desirable additions, secondary to preserving 120 fps. An HDR-to-SDR tone-mapped rendition must still be 120 fps.
- Do not propose or add 30 or 60 fps fallbacks to work around codec, protocol, browser, device, or hardware limitations. State the limitation and seek a solution that preserves 120 fps.
- Do not silently lower the frame rate, duplicate lower-frame-rate frames, or relabel metadata to claim that the 120 fps requirement is satisfied.

These are product requirements, not a claim that the current pipeline already validates every input or output against them.
