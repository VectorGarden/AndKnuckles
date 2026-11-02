/* A zlib stream at level 9, written here rather than taken from node:zlib.

   Node compresses with Chromium's patched zlib, whose output matches neither
   stock zlib nor Go's compress/flate, and can change with a Node release. The
   pipeline's output is checked byte for byte, and it is built by both this and
   its Go port (tools/go), so both carry this same compressor: a transcription
   of stock zlib's deflate_slow and trees.c at level 9 -- 32K window, memLevel 8,
   lazy matching, chains of 4096 -- for whole-buffer input with Z_FINISH. Its
   output is stock zlib's, byte for byte (test/deflate.test.mjs checks it against
   the system zlib through Python), and it is mirrored in tools/go/deflate.go.

   Names follow zlib's, so the two can be read side by side. */

const MIN_MATCH = 3, MAX_MATCH = 258, MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
const W_BITS = 15, W_SIZE = 1 << W_BITS, W_MASK = W_SIZE - 1, MAX_DIST = W_SIZE - MIN_LOOKAHEAD;
const HASH_BITS = 15, HASH_SIZE = 1 << HASH_BITS, HASH_MASK = HASH_SIZE - 1, HASH_SHIFT = 5;
const LIT_BUFSIZE = 1 << 14, SYM_END = (LIT_BUFSIZE - 1) * 3, WIN_INIT = MAX_MATCH, TOO_FAR = 4096;
// configuration_table[9]
const GOOD = 32, LAZY = 258, NICE = 258, CHAIN = 4096;

const LENGTH_CODES = 29, LITERALS = 256, L_CODES = LITERALS + 1 + LENGTH_CODES, D_CODES = 30, BL_CODES = 19;
const HEAP_SIZE = 2 * L_CODES + 1, MAX_BITS = 15, MAX_BL_BITS = 7, END_BLOCK = 256;
const REP_3_6 = 16, REPZ_3_10 = 17, REPZ_11_138 = 18;
const EXTRA_LBITS = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const EXTRA_DBITS = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const EXTRA_BLBITS = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,3,7];
const BL_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

function biReverse(code, len){ let res = 0; do { res |= code & 1; code >>>= 1; res <<= 1; } while(--len > 0); return res >>> 1; }

// A tree is ct_data[]: fc is Freq / Code and dl is Dad / Len, unions in zlib, kept as such.
const tree = n => ({fc: new Uint16Array(n), dl: new Uint16Array(n)});
function genCodes(t, maxCode, blCount){
  const next = new Uint16Array(MAX_BITS + 1);
  let code = 0;
  for(let bits = 1; bits <= MAX_BITS; bits++){ code = (code + blCount[bits - 1]) << 1; next[bits] = code; }
  for(let n = 0; n <= maxCode; n++){ const len = t.dl[n]; if(len === 0) continue; t.fc[n] = biReverse(next[len]++, len); }
}

// tr_static_init
const lengthCode = new Uint8Array(MAX_MATCH - MIN_MATCH + 1), distCode = new Uint8Array(512);
const baseLength = new Int32Array(LENGTH_CODES), baseDist = new Int32Array(D_CODES);
const staticL = tree(L_CODES + 2), staticD = tree(D_CODES);
{
  let length = 0, code;
  for(code = 0; code < LENGTH_CODES - 1; code++){
    baseLength[code] = length;
    for(let n = 0; n < (1 << EXTRA_LBITS[code]); n++) lengthCode[length++] = code;
  }
  lengthCode[length - 1] = code;
  let dist = 0;
  for(code = 0; code < 16; code++){
    baseDist[code] = dist;
    for(let n = 0; n < (1 << EXTRA_DBITS[code]); n++) distCode[dist++] = code;
  }
  dist >>= 7;
  for(; code < D_CODES; code++){
    baseDist[code] = dist << 7;
    for(let n = 0; n < (1 << (EXTRA_DBITS[code] - 7)); n++) distCode[256 + dist++] = code;
  }
  const blCount = new Uint16Array(MAX_BITS + 1);
  let n = 0;
  while(n <= 143){ staticL.dl[n++] = 8; blCount[8]++; }
  while(n <= 255){ staticL.dl[n++] = 9; blCount[9]++; }
  while(n <= 279){ staticL.dl[n++] = 7; blCount[7]++; }
  while(n <= 287){ staticL.dl[n++] = 8; blCount[8]++; }
  genCodes(staticL, L_CODES + 1, blCount);
  for(n = 0; n < D_CODES; n++){ staticD.dl[n] = 5; staticD.fc[n] = biReverse(n, 5); }
}
const dCode = dist => dist < 256 ? distCode[dist] : distCode[256 + (dist >> 7)];

export function deflateSync(input){
  const out = [];                                   // bytes, LSB-first bits as zlib's bi_buf writes them
  let biBuf = 0, biValid = 0;
  const putByte = b => out.push(b & 0xFF);
  const sendBits = (value, length) => {
    biBuf |= (value << biValid) & 0xFFFF;
    if(biValid > 16 - length){
      putByte(biBuf); putByte(biBuf >> 8);
      biBuf = (value >>> (16 - biValid)) & 0xFFFF;
      biValid += length - 16;
    } else biValid += length;
  };
  const biWindup = () => {
    if(biValid > 8){ putByte(biBuf); putByte(biBuf >> 8); }
    else if(biValid > 0) putByte(biBuf);
    biBuf = 0; biValid = 0;
  };
  const sendCode = (c, t) => sendBits(t.fc[c], t.dl[c]);

  // ---- trees.c ----
  const dynL = tree(HEAP_SIZE), dynD = tree(2 * D_CODES + 1), blT = tree(2 * BL_CODES + 1);
  const lDesc = {t: dynL, st: staticL, extra: EXTRA_LBITS, base: LITERALS + 1, elems: L_CODES, maxLength: MAX_BITS, maxCode: 0};
  const dDesc = {t: dynD, st: staticD, extra: EXTRA_DBITS, base: 0, elems: D_CODES, maxLength: MAX_BITS, maxCode: 0};
  const blDesc = {t: blT, st: null, extra: EXTRA_BLBITS, base: 0, elems: BL_CODES, maxLength: MAX_BL_BITS, maxCode: 0};
  const heap = new Int32Array(2 * L_CODES + 1), depth = new Uint8Array(2 * L_CODES + 1), blCount = new Uint16Array(MAX_BITS + 1);
  let heapLen = 0, heapMax = 0, optLen = 0, staticLen = 0;
  const symBuf = new Uint8Array(LIT_BUFSIZE * 3);
  let symNext = 0;
  const initBlock = () => {
    dynL.fc.fill(0, 0, L_CODES); dynD.fc.fill(0, 0, D_CODES); blT.fc.fill(0, 0, BL_CODES);
    dynL.fc[END_BLOCK] = 1; optLen = staticLen = 0; symNext = 0;
  };
  const smaller = (t, n, m) => t.fc[n] < t.fc[m] || (t.fc[n] === t.fc[m] && depth[n] <= depth[m]);
  const pqdownheap = (t, k) => {
    const v = heap[k]; let j = k << 1;
    while(j <= heapLen){
      if(j < heapLen && smaller(t, heap[j + 1], heap[j])) j++;
      if(smaller(t, v, heap[j])) break;
      heap[k] = heap[j]; k = j; j <<= 1;
    }
    heap[k] = v;
  };
  const genBitlen = desc => {
    const t = desc.t, st = desc.st, maxCode = desc.maxCode, extra = desc.extra, base = desc.base, maxLength = desc.maxLength;
    let h, n, m, bits, xbits, f, overflow = 0;
    blCount.fill(0);
    t.dl[heap[heapMax]] = 0;
    for(h = heapMax + 1; h < HEAP_SIZE; h++){
      n = heap[h];
      bits = t.dl[t.dl[n]] + 1;
      if(bits > maxLength){ bits = maxLength; overflow++; }
      t.dl[n] = bits;
      if(n > maxCode) continue;
      blCount[bits]++;
      xbits = 0; if(n >= base) xbits = extra[n - base];
      f = t.fc[n];
      optLen += f * (bits + xbits);
      if(st) staticLen += f * (st.dl[n] + xbits);
    }
    if(overflow === 0) return;
    do {
      bits = maxLength - 1;
      while(blCount[bits] === 0) bits--;
      blCount[bits]--; blCount[bits + 1] += 2; blCount[maxLength]--;
      overflow -= 2;
    } while(overflow > 0);
    for(bits = maxLength; bits !== 0; bits--){
      n = blCount[bits];
      while(n !== 0){
        m = heap[--h];
        if(m > maxCode) continue;
        if(t.dl[m] !== bits){ optLen += (bits - t.dl[m]) * t.fc[m]; t.dl[m] = bits; }
        n--;
      }
    }
  };
  const buildTree = desc => {
    const t = desc.t, st = desc.st, elems = desc.elems;
    let n, m, maxCode = -1, node;
    heapLen = 0; heapMax = HEAP_SIZE;
    for(n = 0; n < elems; n++){
      if(t.fc[n] !== 0){ heap[++heapLen] = maxCode = n; depth[n] = 0; }
      else t.dl[n] = 0;
    }
    while(heapLen < 2){
      node = heap[++heapLen] = (maxCode < 2 ? ++maxCode : 0);
      t.fc[node] = 1; depth[node] = 0; optLen--;
      if(st) staticLen -= st.dl[node];
    }
    desc.maxCode = maxCode;
    for(n = heapLen >> 1; n >= 1; n--) pqdownheap(t, n);
    node = elems;
    do {
      n = heap[1]; heap[1] = heap[heapLen--]; pqdownheap(t, 1);
      m = heap[1];
      heap[--heapMax] = n; heap[--heapMax] = m;
      t.fc[node] = t.fc[n] + t.fc[m];
      depth[node] = (depth[n] >= depth[m] ? depth[n] : depth[m]) + 1;
      t.dl[n] = t.dl[m] = node;
      heap[1] = node++;
      pqdownheap(t, 1);
    } while(heapLen >= 2);
    heap[--heapMax] = heap[1];
    genBitlen(desc);
    genCodes(t, maxCode, blCount);
  };
  const scanTree = (t, maxCode) => {
    let prevlen = -1, curlen, nextlen = t.dl[0], count = 0, maxCount = 7, minCount = 4;
    if(nextlen === 0){ maxCount = 138; minCount = 3; }
    t.dl[maxCode + 1] = 0xFFFF;
    for(let n = 0; n <= maxCode; n++){
      curlen = nextlen; nextlen = t.dl[n + 1];
      if(++count < maxCount && curlen === nextlen) continue;
      else if(count < minCount) blT.fc[curlen] += count;
      else if(curlen !== 0){ if(curlen !== prevlen) blT.fc[curlen]++; blT.fc[REP_3_6]++; }
      else if(count <= 10) blT.fc[REPZ_3_10]++;
      else blT.fc[REPZ_11_138]++;
      count = 0; prevlen = curlen;
      if(nextlen === 0){ maxCount = 138; minCount = 3; }
      else if(curlen === nextlen){ maxCount = 6; minCount = 3; }
      else { maxCount = 7; minCount = 4; }
    }
  };
  const sendTree = (t, maxCode) => {
    let prevlen = -1, curlen, nextlen = t.dl[0], count = 0, maxCount = 7, minCount = 4;
    if(nextlen === 0){ maxCount = 138; minCount = 3; }
    for(let n = 0; n <= maxCode; n++){
      curlen = nextlen; nextlen = t.dl[n + 1];
      if(++count < maxCount && curlen === nextlen) continue;
      else if(count < minCount){ do { sendCode(curlen, blT); } while(--count !== 0); }
      else if(curlen !== 0){
        if(curlen !== prevlen){ sendCode(curlen, blT); count--; }
        sendCode(REP_3_6, blT); sendBits(count - 3, 2);
      } else if(count <= 10){ sendCode(REPZ_3_10, blT); sendBits(count - 3, 3); }
      else { sendCode(REPZ_11_138, blT); sendBits(count - 11, 7); }
      count = 0; prevlen = curlen;
      if(nextlen === 0){ maxCount = 138; minCount = 3; }
      else if(curlen === nextlen){ maxCount = 6; minCount = 3; }
      else { maxCount = 7; minCount = 4; }
    }
  };
  const buildBlTree = () => {
    scanTree(dynL, lDesc.maxCode); scanTree(dynD, dDesc.maxCode);
    buildTree(blDesc);
    let maxBlindex;
    for(maxBlindex = BL_CODES - 1; maxBlindex >= 3; maxBlindex--) if(blT.dl[BL_ORDER[maxBlindex]] !== 0) break;
    optLen += 3 * (maxBlindex + 1) + 5 + 5 + 4;
    return maxBlindex;
  };
  const compressBlock = (lt, dt) => {
    let sx = 0;
    if(symNext !== 0) do {
      let dist = symBuf[sx++]; dist += symBuf[sx++] << 8; let lc = symBuf[sx++];
      if(dist === 0) sendCode(lc, lt);
      else {
        let code = lengthCode[lc]; sendCode(code + LITERALS + 1, lt);
        let extra = EXTRA_LBITS[code]; if(extra !== 0){ lc -= baseLength[code]; sendBits(lc, extra); }
        dist--; code = dCode(dist); sendCode(code, dt);
        extra = EXTRA_DBITS[code]; if(extra !== 0){ dist -= baseDist[code]; sendBits(dist, extra); }
      }
    } while(sx < symNext);
    sendCode(END_BLOCK, lt);
  };
  const flushBlockTr = (buf, storedLen, last) => {
    buildTree(lDesc); buildTree(dDesc);
    const maxBlindex = buildBlTree();
    let optLenb = (optLen + 3 + 7) >>> 3;
    const staticLenb = (staticLen + 3 + 7) >>> 3;
    if(staticLenb <= optLenb) optLenb = staticLenb;
    if(storedLen + 4 <= optLenb && buf >= 0){
      sendBits(last, 3); biWindup();
      putByte(storedLen); putByte(storedLen >> 8); putByte(~storedLen); putByte(~storedLen >> 8);
      for(let i = 0; i < storedLen; i++) putByte(win[buf + i]);
    } else if(staticLenb === optLenb){
      sendBits((1 << 1) + last, 3); compressBlock(staticL, staticD);
    } else {
      sendBits((2 << 1) + last, 3);
      const lcodes = lDesc.maxCode + 1, dcodes = dDesc.maxCode + 1, blcodes = maxBlindex + 1;
      sendBits(lcodes - 257, 5); sendBits(dcodes - 1, 5); sendBits(blcodes - 4, 4);
      for(let rank = 0; rank < blcodes; rank++) sendBits(blT.dl[BL_ORDER[rank]], 3);
      sendTree(dynL, lcodes - 1); sendTree(dynD, dcodes - 1);
      compressBlock(dynL, dynD);
    }
    initBlock();
    if(last) biWindup();
  };
  const tallyLit = c => { symBuf[symNext++] = 0; symBuf[symNext++] = 0; symBuf[symNext++] = c; dynL.fc[c]++; return symNext === SYM_END; };
  const tallyDist = (dist, len) => {
    symBuf[symNext++] = dist & 0xFF; symBuf[symNext++] = (dist >> 8) & 0xFF; symBuf[symNext++] = len;
    dist--; dynL.fc[lengthCode[len] + LITERALS + 1]++; dynD.fc[dCode(dist)]++;
    return symNext === SYM_END;
  };

  // ---- deflate.c ----
  const WINDOW_SIZE = 2 * W_SIZE, win = new Uint8Array(WINDOW_SIZE);
  const prev = new Uint16Array(W_SIZE), head = new Uint16Array(HASH_SIZE);
  let strstart = 0, blockStart = 0, lookahead = 0, insert = 0, insH = 0, highWater = 0;
  let matchLength = MIN_MATCH - 1, prevLength = MIN_MATCH - 1, matchAvailable = 0, matchStart = 0, prevMatch = 0;
  let next = 0;                                      // next input byte
  let adler1 = 1, adler2 = 0;
  const updateHash = (h, c) => ((h << HASH_SHIFT) ^ c) & HASH_MASK;
  const insertString = str => { insH = updateHash(insH, win[str + MIN_MATCH - 1]); const m = prev[str & W_MASK] = head[insH]; head[insH] = str; return m; };
  const readBuf = (at, size) => {
    const len = Math.min(input.length - next, size);
    for(let i = 0; i < len; i++){
      const b = input[next + i]; win[at + i] = b;
      adler1 = (adler1 + b) % 65521; adler2 = (adler2 + adler1) % 65521;
    }
    next += len;
    return len;
  };
  const fillWindow = () => {
    let more;
    do {
      more = WINDOW_SIZE - lookahead - strstart;
      if(strstart >= W_SIZE + MAX_DIST){
        win.copyWithin(0, W_SIZE, W_SIZE + W_SIZE - more);
        matchStart -= W_SIZE; strstart -= W_SIZE; blockStart -= W_SIZE;
        if(insert > strstart) insert = strstart;
        for(let n = 0; n < HASH_SIZE; n++){ const m = head[n]; head[n] = m >= W_SIZE ? m - W_SIZE : 0; }
        for(let n = 0; n < W_SIZE; n++){ const m = prev[n]; prev[n] = m >= W_SIZE ? m - W_SIZE : 0; }
        more += W_SIZE;
      }
      if(next >= input.length) break;
      const n = readBuf(strstart + lookahead, more);
      lookahead += n;
      if(lookahead + insert >= MIN_MATCH){
        let str = strstart - insert;
        insH = win[str];
        insH = updateHash(insH, win[str + 1]);
        while(insert){
          insH = updateHash(insH, win[str + MIN_MATCH - 1]);
          prev[str & W_MASK] = head[insH]; head[insH] = str;
          str++; insert--;
          if(lookahead + insert < MIN_MATCH) break;
        }
      }
    } while(lookahead < MIN_LOOKAHEAD && next < input.length);
    if(highWater < WINDOW_SIZE){
      const curr = strstart + lookahead;
      let init;
      if(highWater < curr){
        init = Math.min(WINDOW_SIZE - curr, WIN_INIT);
        win.fill(0, curr, curr + init);
        highWater = curr + init;
      } else if(highWater < curr + WIN_INIT){
        init = Math.min(curr + WIN_INIT - highWater, WINDOW_SIZE - highWater);
        win.fill(0, highWater, highWater + init);
        highWater += init;
      }
    }
  };
  const longestMatch = curMatch => {
    let chainLength = CHAIN, bestLen = prevLength, niceMatch = NICE;
    const scan = strstart, limit = strstart > MAX_DIST ? strstart - MAX_DIST : 0, strend = strstart + MAX_MATCH;
    let scanEnd1 = win[scan + bestLen - 1], scanEnd = win[scan + bestLen];
    if(prevLength >= GOOD) chainLength >>>= 2;
    if(niceMatch > lookahead) niceMatch = lookahead;
    do {
      const match = curMatch;
      if(win[match + bestLen] !== scanEnd || win[match + bestLen - 1] !== scanEnd1 ||
         win[match] !== win[scan] || win[match + 1] !== win[scan + 1]) continue;
      // scan[2] and match[2] are equal whenever the rest is: same hash, HASH_BITS >= 8
      let s = scan + 2, mm = match + 2;
      do {} while(win[++s] === win[++mm] && s < strend);
      const len = MAX_MATCH - (strend - s);
      if(len > bestLen){
        matchStart = curMatch; bestLen = len;
        if(len >= niceMatch) break;
        scanEnd1 = win[scan + bestLen - 1]; scanEnd = win[scan + bestLen];
      }
    } while((curMatch = prev[curMatch & W_MASK]) > limit && --chainLength !== 0);
    return bestLen <= lookahead ? bestLen : lookahead;
  };
  const flushBlock = last => {
    flushBlockTr(blockStart >= 0 ? blockStart : -1, strstart - blockStart, last);
    blockStart = strstart;
  };

  initBlock();
  out.push(0x78, 0xDA);                              // 32K window, level 9
  for(;;){
    if(lookahead < MIN_LOOKAHEAD){
      fillWindow();
      if(lookahead === 0) break;
    }
    let hashHead = 0;
    if(lookahead >= MIN_MATCH) hashHead = insertString(strstart);
    prevLength = matchLength; prevMatch = matchStart;
    matchLength = MIN_MATCH - 1;
    if(hashHead !== 0 && prevLength < LAZY && strstart - hashHead <= MAX_DIST){
      matchLength = longestMatch(hashHead);
      if(matchLength <= 5 && matchLength === MIN_MATCH && strstart - matchStart > TOO_FAR) matchLength = MIN_MATCH - 1;
    }
    if(prevLength >= MIN_MATCH && matchLength <= prevLength){
      const maxInsert = strstart + lookahead - MIN_MATCH;
      const bflush = tallyDist(strstart - 1 - prevMatch, prevLength - MIN_MATCH);
      lookahead -= prevLength - 1;
      prevLength -= 2;
      do { if(++strstart <= maxInsert) insertString(strstart); } while(--prevLength !== 0);
      matchAvailable = 0; matchLength = MIN_MATCH - 1; strstart++;
      if(bflush) flushBlock(0);
    } else if(matchAvailable){
      if(tallyLit(win[strstart - 1])) flushBlock(0);
      strstart++; lookahead--;
    } else {
      matchAvailable = 1; strstart++; lookahead--;
    }
  }
  if(matchAvailable){ tallyLit(win[strstart - 1]); matchAvailable = 0; }
  insert = strstart < MIN_MATCH - 1 ? strstart : MIN_MATCH - 1;
  flushBlock(1);
  out.push((adler2 >> 8) & 0xFF, adler2 & 0xFF, (adler1 >> 8) & 0xFF, adler1 & 0xFF);
  return Buffer.from(out);
}
