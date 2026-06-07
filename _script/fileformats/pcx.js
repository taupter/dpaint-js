import BinaryStream from "../util/binarystream.js";

const PCX = (function () {
    let me = {};

    me.detect = function (file) {
        if (!file || file.length < 128) return false;
        file.goto(0);
        let manufacturer = file.readUbyte();
        let version = file.readUbyte();
        let encoding = file.readUbyte();
        let bitsPerPixel = file.readUbyte();

        if (manufacturer !== 0x0a) return false;
        if (version < 0 || version > 5) return false;
        if (encoding !== 0 && encoding !== 1) return false;

        return bitsPerPixel === 1 || bitsPerPixel === 2 || bitsPerPixel === 4 || bitsPerPixel === 8;
    };

    me.parse = function (file) {
        if (!me.detect(file)) return false;

        file.goto(0);
        file.readUbyte(); // manufacturer
        let version = file.readUbyte();
        let encoding = file.readUbyte();
        let bitsPerPixel = file.readUbyte();
        let xMin = file.readWord();
        let yMin = file.readWord();
        let xMax = file.readWord();
        let yMax = file.readWord();
        let hDpi = file.readWord();
        let vDpi = file.readWord();

        let headerPalette = [];
        for (let i = 0; i < 16; i++) {
            headerPalette.push([file.readUbyte(), file.readUbyte(), file.readUbyte()]);
        }

        file.readUbyte(); // reserved
        let colorPlanes = file.readUbyte();
        let bytesPerLine = file.readWord();
        let paletteInfo = file.readWord();
        let hScreenSize = file.readWord();
        let vScreenSize = file.readWord();
        file.jump(54); // filler

        let width = xMax - xMin + 1;
        let height = yMax - yMin + 1;
        if (width <= 0 || height <= 0) return false;

        let bytes = new Uint8Array(file.buffer);
        let scanlineSize = bytesPerLine * colorPlanes;
        let expectedDecodedSize = scanlineSize * height;

        let pixelDataEnd = bytes.length;
        let palette256;

        if (bitsPerPixel === 8 && colorPlanes === 1 && bytes.length >= 128 + 769) {
            let paletteMarker = bytes[bytes.length - 769];
            if (paletteMarker === 12) {
                pixelDataEnd = bytes.length - 769;
                palette256 = [];
                for (let i = 0; i < 256; i++) {
                    let p = bytes.length - 768 + i * 3;
                    palette256.push([bytes[p], bytes[p + 1], bytes[p + 2]]);
                }
            }
        }

        let decoded = decodePixelData(bytes, 128, pixelDataEnd, expectedDecodedSize, encoding);

        if (bitsPerPixel === 8 && colorPlanes >= 3) {
            let image = decodeTrueColor(decoded, width, height, bytesPerLine, colorPlanes);
            return {
                image,
                width,
                height,
                bitsPerPixel,
                colorPlanes,
                version,
                hDpi,
                vDpi,
                paletteInfo,
                hScreenSize,
                vScreenSize,
            };
        }

        let pixels;
        if (bitsPerPixel === 8 && colorPlanes === 1) {
            pixels = decode8BitIndexed(decoded, width, height, bytesPerLine);
        } else if (bitsPerPixel === 1) {
            pixels = decode1BitPlanar(decoded, width, height, bytesPerLine, colorPlanes);
        } else if ((bitsPerPixel === 2 || bitsPerPixel === 4) && colorPlanes === 1) {
            pixels = decodePackedIndexed(decoded, width, height, bytesPerLine, bitsPerPixel);
        } else {
            return false;
        }

        let paletteSize = Math.max(1, Math.min(256, 1 << Math.min(8, bitsPerPixel * colorPlanes)));
        let palette = palette256 || headerPalette;
        if (!palette || !palette.length) {
            palette = [];
            for (let i = 0; i < paletteSize; i++) palette.push([i, i, i]);
        }
        palette = normalizePalette(palette, paletteSize);

        let image = indexedToCanvas(pixels, palette, width, height);

        return {
            image,
            palette,
            pixels,
            width,
            height,
            bitsPerPixel,
            colorPlanes,
            version,
            hDpi,
            vDpi,
            paletteInfo,
            hScreenSize,
            vScreenSize,
        };
    };

    // options must contain: bitsPerPixel, colorPlanes, palette (array of [r,g,b] or null for 24-bit)
    me.write = function (canvas, options) {
        let bitsPerPixel = options.bitsPerPixel;
        let colorPlanes  = options.colorPlanes;
        let palette      = options.palette || [];

        let width     = canvas.width;
        let height    = canvas.height;
        let rawPixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;

        let is24bit       = bitsPerPixel === 8 && colorPlanes >= 3;
        let is8bitIndexed = bitsPerPixel === 8 && colorPlanes === 1;
        let isPlanar      = bitsPerPixel === 1;

        // bytesPerLine must be even
        let bytesPerLine = isPlanar
            ? (Math.ceil(width / 8) + (Math.ceil(width / 8) & 1))
            : (width + (width & 1));

        // Fast color→index map for indexed/planar modes
        let colorMap = new Map();
        for (let i = 0; i < palette.length; i++) {
            let c = palette[i];
            colorMap.set((c[0] << 16) | (c[1] << 8) | c[2], i);
        }
        function getIndex(r, g, b) {
            let idx = colorMap.get((r << 16) | (g << 8) | b);
            return idx !== undefined ? idx : 0;
        }

        let encodedLines = [];
        let pixelDataSize = 0;

        for (let y = 0; y < height; y++) {
            let rowOffset = y * width;

            if (is24bit) {
                let rLine = new Uint8Array(bytesPerLine);
                let gLine = new Uint8Array(bytesPerLine);
                let bLine = new Uint8Array(bytesPerLine);
                for (let x = 0; x < width; x++) {
                    let i = (rowOffset + x) * 4;
                    rLine[x] = rawPixels[i];
                    gLine[x] = rawPixels[i + 1];
                    bLine[x] = rawPixels[i + 2];
                }
                let rEnc = rleEncode(rLine), gEnc = rleEncode(gLine), bEnc = rleEncode(bLine);
                encodedLines.push(rEnc, gEnc, bEnc);
                pixelDataSize += rEnc.length + gEnc.length + bEnc.length;

            } else if (is8bitIndexed) {
                let line = new Uint8Array(bytesPerLine);
                for (let x = 0; x < width; x++) {
                    let i = (rowOffset + x) * 4;
                    line[x] = getIndex(rawPixels[i], rawPixels[i + 1], rawPixels[i + 2]);
                }
                let enc = rleEncode(line);
                encodedLines.push(enc);
                pixelDataSize += enc.length;

            } else {
                // 1-bit planar: one plane per bit of the color index
                for (let plane = 0; plane < colorPlanes; plane++) {
                    let planeLine = new Uint8Array(bytesPerLine);
                    for (let x = 0; x < width; x++) {
                        let i = (rowOffset + x) * 4;
                        let idx = getIndex(rawPixels[i], rawPixels[i + 1], rawPixels[i + 2]);
                        if (idx & (1 << plane)) planeLine[x >> 3] |= (0x80 >> (x & 7));
                    }
                    let enc = rleEncode(planeLine);
                    encodedLines.push(enc);
                    pixelDataSize += enc.length;
                }
            }
        }

        let totalSize = 128 + pixelDataSize + (is8bitIndexed ? 769 : 0);
        let file = new BinaryStream(new ArrayBuffer(totalSize));

        // 128-byte header (little-endian)
        file.writeUbyte(0x0a);
        file.writeUbyte(5);
        file.writeUbyte(1);             // RLE encoding
        file.writeUbyte(bitsPerPixel);
        file.writeWord(0);              // xMin
        file.writeWord(0);              // yMin
        file.writeWord(width - 1);      // xMax
        file.writeWord(height - 1);     // yMax
        file.writeWord(72);             // hDpi
        file.writeWord(72);             // vDpi

        // Header palette (16 × 3 bytes): used for 1-bit planar modes
        if (isPlanar) {
            for (let i = 0; i < 16; i++) {
                let c = palette[i] || [0, 0, 0];
                file.writeUbyte(c[0]);
                file.writeUbyte(c[1]);
                file.writeUbyte(c[2]);
            }
        } else {
            file.fill(0, 48);
        }

        file.writeUbyte(0);             // reserved
        file.writeUbyte(colorPlanes);
        file.writeWord(bytesPerLine);
        file.writeWord(1);              // paletteInfo: 1 = color
        file.writeWord(0);              // hScreenSize
        file.writeWord(0);              // vScreenSize
        file.fill(0, 54);              // filler

        for (let enc of encodedLines) file.writeByteArray(enc);

        // 256-color tail palette for 8-bit indexed
        if (is8bitIndexed) {
            file.writeUbyte(0x0c);
            for (let i = 0; i < 256; i++) {
                let c = palette[i] || [0, 0, 0];
                file.writeUbyte(c[0]);
                file.writeUbyte(c[1]);
                file.writeUbyte(c[2]);
            }
        }

        return file.buffer;
    };

    return me;

    function rleEncode(scanline) {
        let output = [];
        let i = 0;
        while (i < scanline.length) {
            let value = scanline[i];
            let count = 1;
            while (count < 63 && i + count < scanline.length && scanline[i + count] === value) {
                count++;
            }
            if (count > 1 || value >= 0xc0) {
                output.push(0xc0 | count);
                output.push(value);
            } else {
                output.push(value);
            }
            i += count;
        }
        return new Uint8Array(output);
    }

    function decodePixelData(bytes, start, end, expectedSize, encoding) {
        let output = new Uint8Array(expectedSize);
        let outIndex = 0;

        if (encoding !== 1) {
            let available = Math.min(expectedSize, Math.max(0, end - start));
            output.set(bytes.subarray(start, start + available));
            return output;
        }

        for (let i = start; i < end && outIndex < expectedSize; i++) {
            let value = bytes[i];
            if ((value & 0xc0) === 0xc0) {
                let runLength = value & 0x3f;
                // Some encoders emit 0xC0 as a literal byte even though the
                // official marker form is C1 C0. Handle this compatibility case.
                if (runLength === 0) {
                    output[outIndex++] = 0xc0;
                    continue;
                }
                i++;
                if (i >= end) break;
                let runValue = bytes[i];
                while (runLength > 0 && outIndex < expectedSize) {
                    output[outIndex++] = runValue;
                    runLength--;
                }
            } else {
                output[outIndex++] = value;
            }
        }

        return output;
    }

    function decodeTrueColor(decoded, width, height, bytesPerLine, colorPlanes) {
        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        let ctx = canvas.getContext("2d");
        let imageData = ctx.createImageData(width, height);
        let data = imageData.data;
        let scanlineSize = bytesPerLine * colorPlanes;

        for (let y = 0; y < height; y++) {
            let rowStart = y * scanlineSize;
            let redOffset = rowStart;
            let greenOffset = rowStart + bytesPerLine;
            let blueOffset = rowStart + bytesPerLine * 2;
            let alphaOffset = rowStart + bytesPerLine * 3;

            for (let x = 0; x < width; x++) {
                let target = (y * width + x) * 4;
                data[target] = decoded[redOffset + x];
                data[target + 1] = decoded[greenOffset + x];
                data[target + 2] = decoded[blueOffset + x];
                data[target + 3] = colorPlanes > 3 ? decoded[alphaOffset + x] : 255;
            }
        }

        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    function decode8BitIndexed(decoded, width, height, bytesPerLine) {
        let pixels = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            let rowOffset = y * bytesPerLine;
            for (let x = 0; x < width; x++) {
                pixels[y * width + x] = decoded[rowOffset + x];
            }
        }
        return pixels;
    }

    function decode1BitPlanar(decoded, width, height, bytesPerLine, colorPlanes) {
        let pixels = new Uint8Array(width * height);
        let scanlineSize = bytesPerLine * colorPlanes;

        for (let y = 0; y < height; y++) {
            let rowStart = y * scanlineSize;
            for (let x = 0; x < width; x++) {
                let byteIndex = x >> 3;
                let mask = 0x80 >> (x & 7);
                let index = 0;
                for (let plane = 0; plane < colorPlanes; plane++) {
                    let source = rowStart + plane * bytesPerLine + byteIndex;
                    if (decoded[source] & mask) index |= (1 << plane);
                }
                pixels[y * width + x] = index;
            }
        }

        return pixels;
    }

    function decodePackedIndexed(decoded, width, height, bytesPerLine, bitsPerPixel) {
        let pixels = new Uint8Array(width * height);
        let pixelsPerByte = 8 / bitsPerPixel;
        let mask = (1 << bitsPerPixel) - 1;

        for (let y = 0; y < height; y++) {
            let rowOffset = y * bytesPerLine;
            for (let x = 0; x < width; x++) {
                let source = decoded[rowOffset + (x / pixelsPerByte | 0)];
                let shift = 8 - bitsPerPixel * ((x % pixelsPerByte) + 1);
                pixels[y * width + x] = (source >> shift) & mask;
            }
        }

        return pixels;
    }

    function normalizePalette(palette, size) {
        let normalized = [];
        for (let i = 0; i < size; i++) {
            let c = palette[i] || [0, 0, 0];
            normalized.push([c[0] | 0, c[1] | 0, c[2] | 0]);
        }
        return normalized;
    }

    function indexedToCanvas(pixels, palette, width, height) {
        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        let ctx = canvas.getContext("2d");
        let imageData = ctx.createImageData(width, height);
        let data = imageData.data;

        for (let i = 0; i < pixels.length; i++) {
            let color = palette[pixels[i]] || [0, 0, 0];
            let target = i * 4;
            data[target] = color[0];
            data[target + 1] = color[1];
            data[target + 2] = color[2];
            data[target + 3] = 255;
        }

        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }
})();

export default PCX;

