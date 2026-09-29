import Foundation

/// 最小 gzip（RFC 1952）编解码，给同步 blob 用（协议 §5.4：payload gzip 后上传）。
///
/// `NSData.compressed(using: .zlib)` 产出的是**裸 DEFLATE**（RFC 1951），
/// 这里只补上 gzip 的头尾（CRC32 + ISIZE）。
public enum Gzip {
    public enum Failure: Error { case invalidHeader, corrupt }

    public static func compress(_ data: Data) throws -> Data {
        let deflated = try (data as NSData).compressed(using: .zlib) as Data
        var out = Data([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff])
        out.append(deflated)
        appendLE(&out, crc32(data))
        appendLE(&out, UInt32(truncatingIfNeeded: data.count))
        return out
    }

    public static func decompress(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= 18, bytes[0] == 0x1f, bytes[1] == 0x8b, bytes[2] == 0x08 else {
            throw Failure.invalidHeader
        }
        let flags = bytes[3]
        var index = 10
        if flags & 0x04 != 0 {  // FEXTRA
            guard index + 2 <= bytes.count else { throw Failure.corrupt }
            let extraLength = Int(bytes[index]) | (Int(bytes[index + 1]) << 8)
            index += 2 + extraLength
        }
        if flags & 0x08 != 0 {  // FNAME
            while index < bytes.count, bytes[index] != 0 { index += 1 }
            index += 1
        }
        if flags & 0x10 != 0 {  // FCOMMENT
            while index < bytes.count, bytes[index] != 0 { index += 1 }
            index += 1
        }
        if flags & 0x02 != 0 { index += 2 }  // FHCRC
        guard index <= bytes.count - 8 else { throw Failure.corrupt }
        let body = Data(bytes[index..<(bytes.count - 8)])
        let inflated = try (body as NSData).decompressed(using: .zlib) as Data
        let expected = UInt32(bytes[bytes.count - 8]) | UInt32(bytes[bytes.count - 7]) << 8
            | UInt32(bytes[bytes.count - 6]) << 16 | UInt32(bytes[bytes.count - 5]) << 24
        guard crc32(inflated) == expected else { throw Failure.corrupt }
        return inflated
    }

    private static func appendLE(_ data: inout Data, _ value: UInt32) {
        data.append(contentsOf: [
            UInt8(value & 0xff), UInt8((value >> 8) & 0xff), UInt8((value >> 16) & 0xff),
            UInt8((value >> 24) & 0xff),
        ])
    }

    private static let table: [UInt32] = (0..<256).map { index -> UInt32 in
        var c = UInt32(index)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in data { crc = table[Int((crc ^ UInt32(byte)) & 0xff)] ^ (crc >> 8) }
        return crc ^ 0xFFFF_FFFF
    }
}
