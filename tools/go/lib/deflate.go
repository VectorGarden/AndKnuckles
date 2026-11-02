package lib

// A zlib stream at level 9: stock zlib's deflate_slow and trees.c, transcribed.
// This mirrors tools/lib/deflate.mjs line for line -- the pipeline is built by
// both, and is checked byte for byte, so the two must compress identically.
// Names follow zlib's.

const (
	minMatch     = 3
	maxMatch     = 258
	minLookahead = maxMatch + minMatch + 1
	wBits        = 15
	wSize        = 1 << wBits
	wMask        = wSize - 1
	maxDist      = wSize - minLookahead
	hashBits     = 15
	hashSize     = 1 << hashBits
	hashMask     = hashSize - 1
	hashShift    = 5
	litBufsize   = 1 << 14
	symEnd       = (litBufsize - 1) * 3
	winInit      = maxMatch
	tooFar       = 4096
	// configuration_table[9]
	goodLength = 32
	maxLazy    = 258
	niceLength = 258
	maxChain   = 4096

	lengthCodes = 29
	literals    = 256
	lCodes      = literals + 1 + lengthCodes
	dCodes      = 30
	blCodes     = 19
	heapSize    = 2*lCodes + 1
	maxBits     = 15
	maxBlBits   = 7
	endBlock    = 256
	rep3_6      = 16
	repz3_10    = 17
	repz11_138  = 18
)

var (
	extraLbits  = []int{0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0}
	extraDbits  = []int{0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13}
	extraBlbits = []int{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7}
	blOrder     = []int{16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15}
)

func biReverse(code, length int) int {
	res := 0
	for {
		res |= code & 1
		code >>= 1
		res <<= 1
		length--
		if length <= 0 {
			break
		}
	}
	return res >> 1
}

// ct_data[]: fc is Freq / Code and dl is Dad / Len, unions in zlib, kept as such.
type ctTree struct{ fc, dl []uint16 }

func newTree(n int) *ctTree { return &ctTree{make([]uint16, n), make([]uint16, n)} }

func genCodes(t *ctTree, maxCode int, blCount []uint16) {
	var next [maxBits + 1]uint16
	code := 0
	for bits := 1; bits <= maxBits; bits++ {
		code = (code + int(blCount[bits-1])) << 1
		next[bits] = uint16(code)
	}
	for n := 0; n <= maxCode; n++ {
		l := int(t.dl[n])
		if l == 0 {
			continue
		}
		t.fc[n] = uint16(biReverse(int(next[l]), l))
		next[l]++
	}
}

// tr_static_init
var (
	lengthCode = make([]uint8, maxMatch-minMatch+1)
	distCode   = make([]uint8, 512)
	baseLength = make([]int, lengthCodes)
	baseDist   = make([]int, dCodes)
	staticL    = newTree(lCodes + 2)
	staticD    = newTree(dCodes)
)

func init() {
	length, code := 0, 0
	for code = 0; code < lengthCodes-1; code++ {
		baseLength[code] = length
		for n := 0; n < 1<<extraLbits[code]; n++ {
			lengthCode[length] = uint8(code)
			length++
		}
	}
	lengthCode[length-1] = uint8(code)
	dist := 0
	for code = 0; code < 16; code++ {
		baseDist[code] = dist
		for n := 0; n < 1<<extraDbits[code]; n++ {
			distCode[dist] = uint8(code)
			dist++
		}
	}
	dist >>= 7
	for ; code < dCodes; code++ {
		baseDist[code] = dist << 7
		for n := 0; n < 1<<(extraDbits[code]-7); n++ {
			distCode[256+dist] = uint8(code)
			dist++
		}
	}
	blCount := make([]uint16, maxBits+1)
	n := 0
	for ; n <= 143; n++ {
		staticL.dl[n] = 8
		blCount[8]++
	}
	for ; n <= 255; n++ {
		staticL.dl[n] = 9
		blCount[9]++
	}
	for ; n <= 279; n++ {
		staticL.dl[n] = 7
		blCount[7]++
	}
	for ; n <= 287; n++ {
		staticL.dl[n] = 8
		blCount[8]++
	}
	genCodes(staticL, lCodes+1, blCount)
	for n = 0; n < dCodes; n++ {
		staticD.dl[n] = 5
		staticD.fc[n] = uint16(biReverse(n, 5))
	}
}

func dCode(dist int) int {
	if dist < 256 {
		return int(distCode[dist])
	}
	return int(distCode[256+(dist>>7)])
}

type treeDesc struct {
	t                *ctTree
	st               *ctTree
	extra            []int
	base, elems, max int
	maxCode          int
}

type deflater struct {
	input []byte
	out   []byte
	biBuf uint32
	biVal int

	dynL, dynD, blT      *ctTree
	lDesc, dDesc, blDesc *treeDesc
	heap                 [2*lCodes + 1]int
	depth                [2*lCodes + 1]uint8
	blCount              [maxBits + 1]uint16
	heapLen, heapMax     int
	optLen, staticLen    int
	symBuf               []uint8
	symNext              int

	win                                     []uint8
	prev, head                              []uint16
	strstart, blockStart, lookahead, insert int
	insH, highWater                         int
	matchLength, prevLength, matchAvailable int
	matchStart, prevMatch                   int
	next                                    int
	adler1, adler2                          uint32
}

func (d *deflater) putByte(b int) { d.out = append(d.out, byte(b)) }
func (d *deflater) sendBits(value, length int) {
	if d.biVal > 16-length {
		d.biBuf |= uint32(value<<d.biVal) & 0xFFFF
		d.putByte(int(d.biBuf))
		d.putByte(int(d.biBuf >> 8))
		d.biBuf = uint32(value>>(16-d.biVal)) & 0xFFFF
		d.biVal += length - 16
	} else {
		d.biBuf |= uint32(value<<d.biVal) & 0xFFFF
		d.biVal += length
	}
}
func (d *deflater) biWindup() {
	if d.biVal > 8 {
		d.putByte(int(d.biBuf))
		d.putByte(int(d.biBuf >> 8))
	} else if d.biVal > 0 {
		d.putByte(int(d.biBuf))
	}
	d.biBuf, d.biVal = 0, 0
}
func (d *deflater) sendCode(c int, t *ctTree) { d.sendBits(int(t.fc[c]), int(t.dl[c])) }

// ---- trees.c ----

func (d *deflater) initBlock() {
	for n := 0; n < lCodes; n++ {
		d.dynL.fc[n] = 0
	}
	for n := 0; n < dCodes; n++ {
		d.dynD.fc[n] = 0
	}
	for n := 0; n < blCodes; n++ {
		d.blT.fc[n] = 0
	}
	d.dynL.fc[endBlock] = 1
	d.optLen, d.staticLen, d.symNext = 0, 0, 0
}
func (d *deflater) smaller(t *ctTree, n, m int) bool {
	return t.fc[n] < t.fc[m] || (t.fc[n] == t.fc[m] && d.depth[n] <= d.depth[m])
}
func (d *deflater) pqdownheap(t *ctTree, k int) {
	v := d.heap[k]
	j := k << 1
	for j <= d.heapLen {
		if j < d.heapLen && d.smaller(t, d.heap[j+1], d.heap[j]) {
			j++
		}
		if d.smaller(t, v, d.heap[j]) {
			break
		}
		d.heap[k] = d.heap[j]
		k = j
		j <<= 1
	}
	d.heap[k] = v
}
func (d *deflater) genBitlen(desc *treeDesc) {
	t, st, maxCode, extra, base, maxLength := desc.t, desc.st, desc.maxCode, desc.extra, desc.base, desc.max
	overflow := 0
	for i := range d.blCount {
		d.blCount[i] = 0
	}
	t.dl[d.heap[d.heapMax]] = 0
	h := d.heapMax + 1
	for ; h < heapSize; h++ {
		n := d.heap[h]
		bits := int(t.dl[t.dl[n]]) + 1
		if bits > maxLength {
			bits = maxLength
			overflow++
		}
		t.dl[n] = uint16(bits)
		if n > maxCode {
			continue
		}
		d.blCount[bits]++
		xbits := 0
		if n >= base {
			xbits = extra[n-base]
		}
		f := int(t.fc[n])
		d.optLen += f * (bits + xbits)
		if st != nil {
			d.staticLen += f * (int(st.dl[n]) + xbits)
		}
	}
	if overflow == 0 {
		return
	}
	for {
		bits := maxLength - 1
		for d.blCount[bits] == 0 {
			bits--
		}
		d.blCount[bits]--
		d.blCount[bits+1] += 2
		d.blCount[maxLength]--
		overflow -= 2
		if overflow <= 0 {
			break
		}
	}
	for bits := maxLength; bits != 0; bits-- {
		n := int(d.blCount[bits])
		for n != 0 {
			h--
			m := d.heap[h]
			if m > maxCode {
				continue
			}
			if int(t.dl[m]) != bits {
				d.optLen += (bits - int(t.dl[m])) * int(t.fc[m])
				t.dl[m] = uint16(bits)
			}
			n--
		}
	}
}
func (d *deflater) buildTree(desc *treeDesc) {
	t, st, elems := desc.t, desc.st, desc.elems
	maxCode := -1
	d.heapLen, d.heapMax = 0, heapSize
	for n := 0; n < elems; n++ {
		if t.fc[n] != 0 {
			d.heapLen++
			d.heap[d.heapLen] = n
			maxCode = n
			d.depth[n] = 0
		} else {
			t.dl[n] = 0
		}
	}
	for d.heapLen < 2 {
		node := 0
		if maxCode < 2 {
			maxCode++
			node = maxCode
		}
		d.heapLen++
		d.heap[d.heapLen] = node
		t.fc[node] = 1
		d.depth[node] = 0
		d.optLen--
		if st != nil {
			d.staticLen -= int(st.dl[node])
		}
	}
	desc.maxCode = maxCode
	for n := d.heapLen >> 1; n >= 1; n-- {
		d.pqdownheap(t, n)
	}
	node := elems
	for {
		n := d.heap[1]
		d.heap[1] = d.heap[d.heapLen]
		d.heapLen--
		d.pqdownheap(t, 1)
		m := d.heap[1]
		d.heapMax--
		d.heap[d.heapMax] = n
		d.heapMax--
		d.heap[d.heapMax] = m
		t.fc[node] = t.fc[n] + t.fc[m]
		dn, dm := d.depth[n], d.depth[m]
		if dn >= dm {
			d.depth[node] = dn + 1
		} else {
			d.depth[node] = dm + 1
		}
		t.dl[n] = uint16(node)
		t.dl[m] = uint16(node)
		d.heap[1] = node
		node++
		d.pqdownheap(t, 1)
		if d.heapLen < 2 {
			break
		}
	}
	d.heapMax--
	d.heap[d.heapMax] = d.heap[1]
	d.genBitlen(desc)
	genCodes(t, maxCode, d.blCount[:])
}
func (d *deflater) scanTree(t *ctTree, maxCode int) {
	prevlen, nextlen, count, maxCount, minCount := -1, int(t.dl[0]), 0, 7, 4
	if nextlen == 0 {
		maxCount, minCount = 138, 3
	}
	t.dl[maxCode+1] = 0xFFFF
	for n := 0; n <= maxCode; n++ {
		curlen := nextlen
		nextlen = int(t.dl[n+1])
		count++
		if count < maxCount && curlen == nextlen {
			continue
		} else if count < minCount {
			d.blT.fc[curlen] += uint16(count)
		} else if curlen != 0 {
			if curlen != prevlen {
				d.blT.fc[curlen]++
			}
			d.blT.fc[rep3_6]++
		} else if count <= 10 {
			d.blT.fc[repz3_10]++
		} else {
			d.blT.fc[repz11_138]++
		}
		count, prevlen = 0, curlen
		if nextlen == 0 {
			maxCount, minCount = 138, 3
		} else if curlen == nextlen {
			maxCount, minCount = 6, 3
		} else {
			maxCount, minCount = 7, 4
		}
	}
}
func (d *deflater) sendTree(t *ctTree, maxCode int) {
	prevlen, nextlen, count, maxCount, minCount := -1, int(t.dl[0]), 0, 7, 4
	if nextlen == 0 {
		maxCount, minCount = 138, 3
	}
	for n := 0; n <= maxCode; n++ {
		curlen := nextlen
		nextlen = int(t.dl[n+1])
		count++
		if count < maxCount && curlen == nextlen {
			continue
		} else if count < minCount {
			for {
				d.sendCode(curlen, d.blT)
				count--
				if count == 0 {
					break
				}
			}
		} else if curlen != 0 {
			if curlen != prevlen {
				d.sendCode(curlen, d.blT)
				count--
			}
			d.sendCode(rep3_6, d.blT)
			d.sendBits(count-3, 2)
		} else if count <= 10 {
			d.sendCode(repz3_10, d.blT)
			d.sendBits(count-3, 3)
		} else {
			d.sendCode(repz11_138, d.blT)
			d.sendBits(count-11, 7)
		}
		count, prevlen = 0, curlen
		if nextlen == 0 {
			maxCount, minCount = 138, 3
		} else if curlen == nextlen {
			maxCount, minCount = 6, 3
		} else {
			maxCount, minCount = 7, 4
		}
	}
}
func (d *deflater) buildBlTree() int {
	d.scanTree(d.dynL, d.lDesc.maxCode)
	d.scanTree(d.dynD, d.dDesc.maxCode)
	d.buildTree(d.blDesc)
	maxBlindex := blCodes - 1
	for ; maxBlindex >= 3; maxBlindex-- {
		if d.blT.dl[blOrder[maxBlindex]] != 0 {
			break
		}
	}
	d.optLen += 3*(maxBlindex+1) + 5 + 5 + 4
	return maxBlindex
}
func (d *deflater) compressBlock(lt, dt *ctTree) {
	sx := 0
	if d.symNext != 0 {
		for {
			dist := int(d.symBuf[sx]) | int(d.symBuf[sx+1])<<8
			lc := int(d.symBuf[sx+2])
			sx += 3
			if dist == 0 {
				d.sendCode(lc, lt)
			} else {
				code := int(lengthCode[lc])
				d.sendCode(code+literals+1, lt)
				if extra := extraLbits[code]; extra != 0 {
					lc -= baseLength[code]
					d.sendBits(lc, extra)
				}
				dist--
				code = dCode(dist)
				d.sendCode(code, dt)
				if extra := extraDbits[code]; extra != 0 {
					dist -= baseDist[code]
					d.sendBits(dist, extra)
				}
			}
			if sx >= d.symNext {
				break
			}
		}
	}
	d.sendCode(endBlock, lt)
}
func (d *deflater) flushBlockTr(buf, storedLen, last int) {
	d.buildTree(d.lDesc)
	d.buildTree(d.dDesc)
	maxBlindex := d.buildBlTree()
	optLenb := (d.optLen + 3 + 7) >> 3
	staticLenb := (d.staticLen + 3 + 7) >> 3
	if staticLenb <= optLenb {
		optLenb = staticLenb
	}
	if storedLen+4 <= optLenb && buf >= 0 {
		d.sendBits(last, 3)
		d.biWindup()
		d.putByte(storedLen)
		d.putByte(storedLen >> 8)
		d.putByte(^storedLen)
		d.putByte(^storedLen >> 8)
		d.out = append(d.out, d.win[buf:buf+storedLen]...)
	} else if staticLenb == optLenb {
		d.sendBits(1<<1+last, 3)
		d.compressBlock(staticL, staticD)
	} else {
		d.sendBits(2<<1+last, 3)
		lcodes, dcodes, blcodes := d.lDesc.maxCode+1, d.dDesc.maxCode+1, maxBlindex+1
		d.sendBits(lcodes-257, 5)
		d.sendBits(dcodes-1, 5)
		d.sendBits(blcodes-4, 4)
		for rank := 0; rank < blcodes; rank++ {
			d.sendBits(int(d.blT.dl[blOrder[rank]]), 3)
		}
		d.sendTree(d.dynL, lcodes-1)
		d.sendTree(d.dynD, dcodes-1)
		d.compressBlock(d.dynL, d.dynD)
	}
	d.initBlock()
	if last != 0 {
		d.biWindup()
	}
}
func (d *deflater) tallyLit(c uint8) bool {
	d.symBuf[d.symNext], d.symBuf[d.symNext+1], d.symBuf[d.symNext+2] = 0, 0, c
	d.symNext += 3
	d.dynL.fc[c]++
	return d.symNext == symEnd
}
func (d *deflater) tallyDist(dist, length int) bool {
	d.symBuf[d.symNext], d.symBuf[d.symNext+1], d.symBuf[d.symNext+2] = uint8(dist), uint8(dist>>8), uint8(length)
	d.symNext += 3
	dist--
	d.dynL.fc[int(lengthCode[length])+literals+1]++
	d.dynD.fc[dCode(dist)]++
	return d.symNext == symEnd
}

// ---- deflate.c ----

const windowSize = 2 * wSize

func updateHash(h int, c uint8) int { return ((h << hashShift) ^ int(c)) & hashMask }

func (d *deflater) insertString(str int) int {
	d.insH = updateHash(d.insH, d.win[str+minMatch-1])
	m := int(d.head[d.insH])
	d.prev[str&wMask] = uint16(m)
	d.head[d.insH] = uint16(str)
	return m
}
func (d *deflater) readBuf(at, size int) int {
	n := len(d.input) - d.next
	if size < n {
		n = size
	}
	for i := 0; i < n; i++ {
		b := d.input[d.next+i]
		d.win[at+i] = b
		d.adler1 = (d.adler1 + uint32(b)) % 65521
		d.adler2 = (d.adler2 + d.adler1) % 65521
	}
	d.next += n
	return n
}
func (d *deflater) fillWindow() {
	for {
		more := windowSize - d.lookahead - d.strstart
		if d.strstart >= wSize+maxDist {
			copy(d.win[0:wSize-more], d.win[wSize:wSize+wSize-more])
			d.matchStart -= wSize
			d.strstart -= wSize
			d.blockStart -= wSize
			if d.insert > d.strstart {
				d.insert = d.strstart
			}
			for n := 0; n < hashSize; n++ {
				if m := int(d.head[n]); m >= wSize {
					d.head[n] = uint16(m - wSize)
				} else {
					d.head[n] = 0
				}
			}
			for n := 0; n < wSize; n++ {
				if m := int(d.prev[n]); m >= wSize {
					d.prev[n] = uint16(m - wSize)
				} else {
					d.prev[n] = 0
				}
			}
			more += wSize
		}
		if d.next >= len(d.input) {
			break
		}
		d.lookahead += d.readBuf(d.strstart+d.lookahead, more)
		if d.lookahead+d.insert >= minMatch {
			str := d.strstart - d.insert
			d.insH = int(d.win[str])
			d.insH = updateHash(d.insH, d.win[str+1])
			for d.insert != 0 {
				d.insH = updateHash(d.insH, d.win[str+minMatch-1])
				d.prev[str&wMask] = d.head[d.insH]
				d.head[d.insH] = uint16(str)
				str++
				d.insert--
				if d.lookahead+d.insert < minMatch {
					break
				}
			}
		}
		if !(d.lookahead < minLookahead && d.next < len(d.input)) {
			break
		}
	}
	if d.highWater < windowSize {
		curr := d.strstart + d.lookahead
		if d.highWater < curr {
			init := min(windowSize-curr, winInit)
			clear(d.win[curr : curr+init])
			d.highWater = curr + init
		} else if d.highWater < curr+winInit {
			init := min(curr+winInit-d.highWater, windowSize-d.highWater)
			clear(d.win[d.highWater : d.highWater+init])
			d.highWater += init
		}
	}
}

// at reads the window as the JS does: past the end is undefined, equal only to itself
func (d *deflater) at(i int) int {
	if i < len(d.win) {
		return int(d.win[i])
	}
	return -1
}
func (d *deflater) longestMatch(curMatch int) int {
	chainLength, bestLen, niceMatch := maxChain, d.prevLength, niceLength
	scan := d.strstart
	limit := 0
	if d.strstart > maxDist {
		limit = d.strstart - maxDist
	}
	strend := d.strstart + maxMatch
	scanEnd1, scanEnd := d.at(scan+bestLen-1), d.at(scan+bestLen)
	if d.prevLength >= goodLength {
		chainLength >>= 2
	}
	if niceMatch > d.lookahead {
		niceMatch = d.lookahead
	}
	for {
		match := curMatch
		if !(d.at(match+bestLen) != scanEnd || d.at(match+bestLen-1) != scanEnd1 ||
			d.at(match) != d.at(scan) || d.at(match+1) != d.at(scan+1)) {
			// scan[2] and match[2] are equal whenever the rest is: same hash, hashBits >= 8
			s, mm := scan+2, match+2
			for {
				s++
				mm++
				if !(d.at(s) == d.at(mm) && s < strend) {
					break
				}
			}
			l := maxMatch - (strend - s)
			if l > bestLen {
				d.matchStart = curMatch
				bestLen = l
				if l >= niceMatch {
					break
				}
				scanEnd1, scanEnd = d.at(scan+bestLen-1), d.at(scan+bestLen)
			}
		}
		curMatch = int(d.prev[curMatch&wMask])
		if curMatch <= limit {
			break
		}
		chainLength--
		if chainLength == 0 {
			break
		}
	}
	if bestLen <= d.lookahead {
		return bestLen
	}
	return d.lookahead
}
func (d *deflater) flushBlock(last int) {
	buf := -1
	if d.blockStart >= 0 {
		buf = d.blockStart
	}
	d.flushBlockTr(buf, d.strstart-d.blockStart, last)
	d.blockStart = d.strstart
}

// Deflate compresses input as one zlib stream at level 9, as tools/lib/deflate.mjs does.
func Deflate(input []byte) []byte {
	d := &deflater{input: input, symBuf: make([]uint8, litBufsize*3),
		win: make([]uint8, windowSize), prev: make([]uint16, wSize), head: make([]uint16, hashSize),
		matchLength: minMatch - 1, prevLength: minMatch - 1, adler1: 1}
	d.dynL, d.dynD, d.blT = newTree(heapSize), newTree(2*dCodes+1), newTree(2*blCodes+1)
	d.lDesc = &treeDesc{t: d.dynL, st: staticL, extra: extraLbits, base: literals + 1, elems: lCodes, max: maxBits}
	d.dDesc = &treeDesc{t: d.dynD, st: staticD, extra: extraDbits, base: 0, elems: dCodes, max: maxBits}
	d.blDesc = &treeDesc{t: d.blT, st: nil, extra: extraBlbits, base: 0, elems: blCodes, max: maxBlBits}
	d.initBlock()
	d.out = append(d.out, 0x78, 0xDA) // 32K window, level 9
	for {
		if d.lookahead < minLookahead {
			d.fillWindow()
			if d.lookahead == 0 {
				break
			}
		}
		hashHead := 0
		if d.lookahead >= minMatch {
			hashHead = d.insertString(d.strstart)
		}
		d.prevLength, d.prevMatch = d.matchLength, d.matchStart
		d.matchLength = minMatch - 1
		if hashHead != 0 && d.prevLength < maxLazy && d.strstart-hashHead <= maxDist {
			d.matchLength = d.longestMatch(hashHead)
			if d.matchLength <= 5 && d.matchLength == minMatch && d.strstart-d.matchStart > tooFar {
				d.matchLength = minMatch - 1
			}
		}
		if d.prevLength >= minMatch && d.matchLength <= d.prevLength {
			maxInsert := d.strstart + d.lookahead - minMatch
			bflush := d.tallyDist(d.strstart-1-d.prevMatch, d.prevLength-minMatch)
			d.lookahead -= d.prevLength - 1
			d.prevLength -= 2
			for {
				d.strstart++
				if d.strstart <= maxInsert {
					d.insertString(d.strstart)
				}
				d.prevLength--
				if d.prevLength == 0 {
					break
				}
			}
			d.matchAvailable = 0
			d.matchLength = minMatch - 1
			d.strstart++
			if bflush {
				d.flushBlock(0)
			}
		} else if d.matchAvailable != 0 {
			if d.tallyLit(d.win[d.strstart-1]) {
				d.flushBlock(0)
			}
			d.strstart++
			d.lookahead--
		} else {
			d.matchAvailable = 1
			d.strstart++
			d.lookahead--
		}
	}
	if d.matchAvailable != 0 {
		d.tallyLit(d.win[d.strstart-1])
		d.matchAvailable = 0
	}
	d.flushBlock(1)
	d.out = append(d.out, byte(d.adler2>>8), byte(d.adler2), byte(d.adler1>>8), byte(d.adler1))
	return d.out
}
