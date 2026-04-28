# DASH muxer test fixtures

Small fragmented-MP4 (CMAF) bytes from the **Big Buck Bunny** DASH-IF test stream
hosted at `https://dash.akamaized.net/akamai/bbb_30fps/`. Each file is the init
segment + first media segment for the lowest-bandwidth variant, concatenated
into a single self-contained fMP4 file (the same shape `dash-mux.ts` expects
as input).

| File | Source | Size |
| ---- | ------ | ---- |
| `video.m4v` | `bbb_30fps_320x180_200k/bbb_30fps_320x180_200k_0.m4v` + `_1.m4v` | ~91 KB |
| `audio.m4a` | `bbb_a64k/bbb_a64k_0.m4a` + `bbb_a64k_1.m4a` | ~33 KB |

Big Buck Bunny is © Blender Foundation, distributed under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/)
and freely redistributable with attribution. These fixtures are committed to
the repository purely to verify the DASH muxer (`extension/src/workers/dash-mux.ts`)
against real-world fMP4 bytes; without them, the muxer's mp4box.js code paths
have no automated coverage.

To regenerate (e.g. if the upstream test stream changes), run from this
directory:

```sh
curl -o video-init.bin https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_320x180_200k/bbb_30fps_320x180_200k_0.m4v
curl -o video-seg1.bin https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_320x180_200k/bbb_30fps_320x180_200k_1.m4v
cat  video-init.bin video-seg1.bin > video.m4v
curl -o audio-init.bin https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_0.m4a
curl -o audio-seg1.bin https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_1.m4a
cat  audio-init.bin audio-seg1.bin > audio.m4a
rm   video-init.bin video-seg1.bin audio-init.bin audio-seg1.bin
```
