# Street View Stitcher

Load: chrome://extensions → Developer mode → Load unpacked → pick this folder.

Use: open Street View in Google Maps. Click the ⤓ button. The camera is read
immediately when capture starts; heading, panorama-centre heading, pitch, FOV,
and roll are normalized into one camera model before stitching. Heading and
Pitch follows the current Street View camera using the same URL synchronization
as heading; moving the pitch slider temporarily preserves manual control.
Set panorama centre heading when the tile equirectangular centre column is not
world north.
Pick tile quality and output size.
"Capture 16:9" saves a reprojected photo; "Panorama" saves the raw stitched sphere.
Pitch, roll, FOV, tile quality, and output size are saved in extension storage
and restored when Street View loads a new frame. The panorama centre heading
is looked up from Google’s panorama metadata for each new panorama, with the
manual value retained if metadata is unavailable. Press `P` anywhere on the
Street View page to quickly save the current 16:9 view.
You can start another capture while a previous capture is still stitching; each
capture uses the camera state from when it was started.

Notes:
- Tile quality 3 is the sweet spot. 4 and 5 pull far more requests.
- Only the tile band the view needs is downloaded, not the whole sphere.
- The panorama is stitched as a 2:1 equirectangular image, then reprojected to
  a rectilinear view. Pitch and manual roll correction are applied as 3D
  rotations before spherical coordinates are sampled.
- Camera checks: positive pitch looks toward the sky, negative pitch toward
  the road, and a zero-pitch view places the horizon at source `v = 0.5`.
- Not affiliated with Google. Use within the Maps terms for personal captures.