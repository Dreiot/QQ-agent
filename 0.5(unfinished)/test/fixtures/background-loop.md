# Background playback fixtures

Both files contain only a synthetic moving test pattern, 320 x 180 at 15 fps,
without audio. They exercise actual native decoding, looping and HTTP seeking.

Generated with FFmpeg:

```text
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=15 -t 1.5 -an -c:v libvpx -b:v 200k background-loop.webm
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=15 -t 1.5 -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart background-loop.mp4
```
