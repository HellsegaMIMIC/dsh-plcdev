'use strict';
// Decode with Node's streaming StringDecoder before joining chunks. A single
// Chinese character or emoji may be split across several stdout pipe chunks.
function collectUtf8(stream,onChunk){
 stream.setEncoding('utf8');
 stream.on('data',chunk=>onChunk(chunk,Buffer.byteLength(chunk,'utf8')));
}
module.exports={collectUtf8};
