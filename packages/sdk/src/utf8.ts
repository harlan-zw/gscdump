/** UTF-8 byte length without allocating the encoded byte array. */
export function utf8Size(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7F) {
      bytes++
    }
    else if (code <= 0x7FF) {
      bytes += 2
    }
    else if (code >= 0xD800 && code <= 0xDBFF
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xDC00
      && value.charCodeAt(index + 1) <= 0xDFFF) {
      bytes += 4
      index++
    }
    else {
      // BMP code points and unpaired surrogates (encoded as U+FFFD).
      bytes += 3
    }
  }
  return bytes
}
