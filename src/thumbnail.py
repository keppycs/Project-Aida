import subprocess
import sys
import os

# This is a standalone script for now. To use it, run: thumbnail.py {input_path}
# This will generate the four thumbnails.

# I still need to implement this script to the pipeline

def generate_thumbnails(input_path):
    if not os.path.exists(input_path):
        print(f"Error: File '{input_path}' not found.")
        return

    # Define the commands with placeholders
    commands = [
    [
        "ffmpeg", "-y", "-ss", "00:00:05", "-i", input_path, "-frames:v", "1",
        "-c:v", "libsvtav1", "-pix_fmt", "yuv420p10le", "-svtav1-params", "tune=0:enable-hdr=1",
        "-color_range", "tv", "-color_primaries", "bt2020", "-color_trc", "smpte2084",
        "-colorspace", "bt2020nc", "-crf", "20", "thumbnail_hdr.avif"
    ],
    [
        "ffmpeg", "-y", "-ss", "00:00:05", "-i", input_path, "-frames:v", "1",
        "-vf", "zscale=w=1280:h=720:f=lanczos,format=yuv420p10le",
        "-c:v", "libsvtav1", "-svtav1-params", "tune=0:enable-hdr=1",
        "-color_range", "tv", "-color_primaries", "bt2020", "-color_trc", "smpte2084",
        "-colorspace", "bt2020nc", "-crf", "20", "thumbnail_hdr_720p.avif"
    ],
    [
        "ffmpeg", "-y", "-ss", "00:00:05", "-i", input_path, "-frames:v", "1",
        "-vf", "zscale=t=linear:npl=1000,format=gbrpf32le,tonemap=mobius,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p",
        "-c:v", "libwebp", "-lossless", "0", "-compression_level", "6", "-q:v", "80", "thumbnail_sdr.webp"
    ],
    [
        "ffmpeg", "-y", "-ss", "00:00:05", "-i", input_path, "-frames:v", "1",
        "-vf", "zscale=w=1280:h=720:f=lanczos,zscale=t=linear:npl=1000,format=gbrpf32le,tonemap=mobius,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p",
        "-c:v", "libwebp", "-lossless", "0", "-compression_level", "6", "-q:v", "80", "thumbnail_sdr_720p.webp"
    ]
]

    for cmd in commands:
        output_filename = cmd[-1]
        print(f"Generating {output_filename}...")
        try:
            # Using check=True to raise an error if a command fails
            subprocess.run(cmd, check=True, capture_output=True)
            print(f"Successfully created {output_filename}")
        except subprocess.CalledProcessError as e:
            print(f"Error generating {output_filename}: {e.stderr.decode()}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python script.py <path_to_video>")
    else:
        generate_thumbnails(sys.argv[1])