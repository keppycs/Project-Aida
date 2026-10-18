import test from "node:test";
import assert from "node:assert/strict";
import { parseDash, parseMaster, parseMedia, PackageError } from "../edge/admin-package.mjs";
import { packageFixture } from "./admin-package-fixtures.mjs";

test("realistic FFmpeg static video+audio package and every HLS rendition agree", () => {
  for (const codec of ["AV1", "HEVC"]) {
    const f = packageFixture(codec), reps = parseDash(f.mpd, codec, f.metadata);
    assert.deepEqual(reps.map(({ id, type, minimumSegments }) => ({ id, type, minimumSegments })), [{ id:"0", type:"video", minimumSegments:2 }, { id:"1", type:"video", minimumSegments:2 }, { id:"2", type:"audio", minimumSegments:2 }]);
    assert.deepEqual(new Set(parseMaster(f.master, reps)), new Set(["media_0.m3u8","media_1.m3u8","media_2.m3u8"]));
    for (const rep of reps) assert.deepEqual(parseMedia(f.objects.get(`${codec}/${rep.playlist}`), rep), [`init_${rep.id}.mp4`, `chunk_${rep.id}_1.fmp4`, `chunk_${rep.id}_2.fmp4`]);
  }
});

test("DASH parsing rejects malformed XML, comments masquerading as XML and entity/namespace tricks", () => {
  const f = packageFixture();
  for (const bad of [
    "not XML frameRate=\"120\"", '<!-- <MPD><Representation frameRate="120"/></MPD> -->',
    f.mpd.replace("</Period>", "</Wrong>"), f.mpd.replace("</MPD>", ""), f.mpd + f.mpd,
    f.mpd.replace('type="static"', 'type="static" type="dynamic"'),
    f.mpd.replace('<MPD ', '<!DOCTYPE MPD [<!ENTITY external SYSTEM "file:///private">]><MPD '),
    f.mpd.replace('frameRate="120/1"', 'frameRate="&external;"'),
    f.mpd.replace('xmlns="urn:mpeg:dash:schema:mpd:2011"','xmlns="https://attacker.invalid"'),
    f.mpd.replace('<Period ', '<Period xlink:href="https://attacker.invalid/period" '),
    f.mpd.replace('width="1280"','width=1280'), f.mpd.replace('width="1280"','width="1280'), f.mpd.replace(' width="1280"','\u00a0width="1280"'), f.mpd.replace('<ProgramInformation>','<!--bad\u0000--><ProgramInformation>'), f.mpd.replace('version="1.0"',`version="1.0'`), f.mpd+'&#32;',
    f.mpd.replace('<ProgramInformation>', '<ProgramInformation><Representation id="99" frameRate="120"/>')
  ]) assert.throws(() => parseDash(bad,"AV1",f.metadata), PackageError);
});

test("effective frame rate is required on every video representation including lower tiers", () => {
  const f = packageFixture();
  for (const bad of [f.mpd.replace('frameRate="120/1"',''), f.mpd.replace('<Representation id="1"','<Representation frameRate="60" id="1"'), f.mpd.replace('frameRate="120/1"','frameRate="119.88"'), f.mpd.replace('frameRate="120/1"','frameRate="120.0000000000000001"'), f.mpd.replace('frameRate="120/1"','frameRate="0/0"')]) assert.throws(() => parseDash(bad,"AV1",f.metadata), /120 fps/);
  assert.equal(parseDash(f.mpd.replace('frameRate="120/1"','frameRate="240/2"'),"AV1",f.metadata).length,3);
  const overrides = f.mpd.replace('frameRate="120/1"','frameRate="60"').replace(/<Representation id="([01])"/g,'<Representation frameRate="120" id="$1"');
  assert.equal(parseDash(overrides,"AV1",f.metadata).length,3);
});

test("DASH references must stay in the actual supported package layout", () => {
  const f = packageFixture();
  for (const bad of [f.mpd.replace('<Period ', '<BaseURL>https://attacker.invalid/</BaseURL><Period '), f.mpd.replace('media="chunk_', 'media="../chunk_'), f.mpd.replace('media="chunk_', 'media="https://attacker.invalid/chunk_'), f.mpd.replace('<SegmentTemplate ', '<SegmentTemplate index="https://attacker.invalid/index" '), f.mpd.replace('type="static"','type="dynamic"'), f.mpd.replace('mediaPresentationDuration="PT8.0S"','mediaPresentationDuration="PT80S"'), f.mpd.replace('codecs="av01.','codecs="hvc1.'), f.mpd.replace('<SegmentTemplate ','<SegmentTimeline/><SegmentTemplate '), f.mpd.replace('duration="4000000"','duration="1"')]) assert.throws(() => parseDash(bad,"AV1",f.metadata), PackageError);
});

test("informational XML text cannot supply a fake frame rate or an asset reference", () => {
  const f=packageFixture(),info='<ProgramInformation><Title>Title &amp; notes &lt;safe&gt;</Title><Source>Camera</Source></ProgramInformation>';
  assert.equal(parseDash(f.mpd.replace('<ProgramInformation></ProgramInformation>',info),'AV1',f.metadata).length,3);
  assert.throws(()=>parseDash(f.mpd.replace('<ProgramInformation></ProgramInformation>',info.replace('Camera','frameRate="120"')).replace('frameRate="120/1"',''),'AV1',f.metadata),/120 fps/);
});

test("HLS master must include matching120fps video tiers and declared audio", () => {
  const f=packageFixture(),reps=parseDash(f.mpd,"AV1",f.metadata);
  for (const bad of [f.master.replace('FRAME-RATE=120','FRAME-RATE=60'), f.master.replace(',FRAME-RATE=120',''), f.master.replace('media_0.m3u8','https://attacker.invalid/media_0.m3u8'), f.master.replace('RESOLUTION=1280x720','RESOLUTION=1920x1080'), f.master.replace('URI="media_2.m3u8"','URI="../media_2.m3u8"'), f.master.replace('AUDIO="group_A1"','AUDIO="unknown"'), f.master.replace('CODECS="av01.','CODECS="hvc1.'), f.master.replace(/#EXT-X-STREAM-INF:[^\n]+\nmedia_1.m3u8/,'')]) assert.throws(() => parseMaster(bad,reps),PackageError);
});

test("HLS media requires end marker, exact sequence/init, all contiguous chunks and complete duration", () => {
  const f=packageFixture(),rep=parseDash(f.mpd,"AV1",f.metadata)[0],playlist=f.objects.get('AV1/media_0.m3u8');
  for(const bad of [playlist.replace('#EXT-X-ENDLIST',''),playlist.replace('init_0.mp4','init_1.mp4'),playlist.replace('chunk_0_1.fmp4','chunk_0_2.fmp4'),playlist.replace('chunk_0_2.fmp4','../chunk_0_2.fmp4'),playlist.replace('#EXT-X-MEDIA-SEQUENCE:1','#EXT-X-MEDIA-SEQUENCE:2'),playlist.replace('#EXTINF:4.000000,','#EXTINF:1.000000,'),playlist.replace('#EXT-X-MAP:', '#EXT-X-KEY:URI="https://attacker.invalid/key"\n#EXT-X-MAP:'),playlist+'#EXTINF:1,\nchunk_0_3.fmp4',playlist.replace('#EXT-X-TARGETDURATION:4','')])assert.throws(()=>parseMedia(bad,rep),PackageError);
});

test("the FFmpeg rounded MPD duration may differ slightly from final120fps/audio timestamps", () => {
  const f=packageFixture(),rep=parseDash(f.mpd.replace('PT8.0S','PT7.9S'),"AV1",f.metadata)[0];
  assert.equal(parseMedia(f.objects.get('AV1/media_0.m3u8'),rep).length,3);
});

test("valid prefixed DASH namespace and padded segment templates remain supported",()=>{
  const f=packageFixture();
  const prefixed=f.mpd.replace('xmlns="urn:mpeg:dash:schema:mpd:2011"','xmlns:d="urn:mpeg:dash:schema:mpd:2011"').replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)/g,'<$1d:$2');
  assert.equal(parseDash(prefixed,'AV1',f.metadata).length,3);
  const rep=parseDash(f.mpd.replaceAll('$Number$','$Number%05d$'),'AV1',f.metadata)[0];
  assert.deepEqual(parseMedia(f.objects.get('AV1/media_0.m3u8').replaceAll('chunk_0_1.fmp4','chunk_0_00001.fmp4').replaceAll('chunk_0_2.fmp4','chunk_0_00002.fmp4'),rep),['init_0.mp4','chunk_0_00001.fmp4','chunk_0_00002.fmp4']);
});
