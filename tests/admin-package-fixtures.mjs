/** Synthetic package matching FFmpeg's -use_template1 -use_timeline0 output. */
export function packageFixture(codec = "AV1", videos = 2, audio = true) {
  const videoCodec = codec === "AV1" ? "av01.0.08M.08.0.110.01.01.01.0" : "hvc1.1.6.L120.B0";
  const template = '<SegmentTemplate timescale="1000000" duration="4000000" initialization="init_$RepresentationID$.mp4" media="chunk_$RepresentationID$_$Number$.fmp4" startNumber="1"></SegmentTemplate>';
  const video = Array.from({ length: videos }, (_, index) => `<Representation id="${index}" mimeType="video/mp4" codecs="${videoCodec}" bandwidth="1000000" width="${index ? 640 : 1280}" height="${index ? 360 : 720}">${template}</Representation>`).join("");
  const sound = audio ? `<AdaptationSet id="1" contentType="audio" lang="und"><Representation id="${videos}" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="320000" audioSamplingRate="48000"><AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>${template}</Representation></AdaptationSet>` : "";
  const mpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xlink="http://www.w3.org/1999/xlink" xsi:schemaLocation="urn:mpeg:DASH:schema:MPD:2011 http://standards.iso.org/DASH-MPD.xsd" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT8.0S" maxSegmentDuration="PT4.0S" minBufferTime="PT8.0S"><ProgramInformation></ProgramInformation><ServiceDescription id="0"></ServiceDescription><Period id="0" start="PT0.0S"><AdaptationSet id="0" contentType="video" frameRate="120/1">${video}</AdaptationSet>${sound}</Period></MPD>`;
  const streams = Array.from({ length: videos }, (_, index) => `#EXT-X-STREAM-INF:BANDWIDTH=1320000,RESOLUTION=${index ? "640x360" : "1280x720"},CODECS="${videoCodec}${audio ? ",mp4a.40.2" : ""}"${audio ? ',AUDIO="group_A1"' : ""},VIDEO-RANGE=SDR,FRAME-RATE=120\nmedia_${index}.m3u8`).join("\n\n");
  const master = `#EXTM3U\n#EXT-X-VERSION:7\n${audio ? `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_A1",NAME="audio_${videos}",DEFAULT=YES,CHANNELS="2",URI="media_${videos}.m3u8"\n` : ""}${streams}\n`;
  const objects = new Map([[`${codec}/manifest.mpd`, mpd], [`${codec}/master.m3u8`, master]]);
  for (let index = 0; index < videos + Number(audio); index++) {
    objects.set(`${codec}/media_${index}.m3u8`, `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-MAP:URI="init_${index}.mp4"\n#EXTINF:4.000000,\n#EXT-X-PROGRAM-DATE-TIME:2026-03-25T14:49:05.000+0100\nchunk_${index}_1.fmp4\n#EXTINF:4.000000,\n#EXT-X-PROGRAM-DATE-TIME:2026-03-25T14:49:09.000+0100\nchunk_${index}_2.fmp4\n#EXT-X-ENDLIST\n`);
    objects.set(`${codec}/init_${index}.mp4`, new Uint8Array([0,0,0,24,102,116,121,112]));
    objects.set(`${codec}/chunk_${index}_1.fmp4`, new Uint8Array([0,0,0,24,115,116,121,112]));
    objects.set(`${codec}/chunk_${index}_2.fmp4`, new Uint8Array([0,0,0,24,109,111,111,102]));
  }
  return { mpd, master, objects, metadata: { codecs: [codec], frameRate: 120, duration: 8 } };
}
