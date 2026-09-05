# ClipHutch — fixtures

Local test page producing predictable network requests for the extension's detection layer.

## Run

```bash
cd fixtures/video-test-page
python3 server.py
```

Then open http://localhost:8000. Stdlib-only (no pip deps); explicit MIME overrides for `.m3u8`, `.ts`, `.mp4`, `.webm`, `.mpd`, `.aac`.

## Sections

| # | Path | Type | Purpose |
| - | ---- | ---- | ------- |
| 1 | `direct.mp4` | MP4 (h264 + aac) | Direct download via `<video>` |
| 2 | `direct.webm` | WebM (vp9 + opus) | Direct download via `<video>` |
| 3 | `hls-simple/playlist.m3u8` | HLS VOD | Embedded audio, unencrypted — Session 5 happy path |
| 4 | `hls-master-embedded/master.m3u8` | HLS master | Two variants, both with embedded audio |
| 5 | `hls-master-separate-audio/master.m3u8` | HLS master | `EXT-X-MEDIA TYPE=AUDIO` rendition — Session 5 rejects |
| 6 | `hls-encrypted/playlist.m3u8` | HLS VOD | Real AES-128 encrypted segments with sequence-derived IVs; download must play |
| 7 | `hls-encrypted-iv/playlist.m3u8` | HLS VOD | Real AES-128 encrypted segments with an explicit IV and media sequence 5; download must play |
| 8 | `hls-master-separate-audio-ts/master.m3u8` | HLS master | MPEG-TS video plus separate MPEG-TS AAC audio; download must produce one MP4 with sound |
| 9 | `hls-master-separate-audio-ts-aes/master.m3u8` | HLS master | AES-128 MPEG-TS video plus separate AES-128 MPEG-TS AAC audio; download must produce one MP4 with sound |

Total fixture size: under 15 MB.

## Notes

- Section 5 ships with empty stub segments. It fires the right network requests but is not playable; that is intentional. Sections 6 and 7 contain real encrypted segments and 16-byte keys. Sections 8 and 9 contain real separate video and audio renditions.
- No `hls.js` or third-party player is bundled. HLS sections issue a single `fetch()` for the master/playlist; segment fetches happen only when the extension downloads (Session 5).
- Direct MP4/WebM keyframe interval is 2s (`-g 60` at 30fps), which is what lets `hls-simple` and `hls-master-embedded/high` be cut by `-c copy` into 5 clean segments without re-encoding.
