package dev.boujoy.personalagent;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Set;
import java.util.UUID;

/** Public wire format shared with the Node relay. No application payload is decrypted here. */
public final class Protocol {
    public static final int VERSION = 1, HEADER_BYTES = 5, MAX_CHUNK = 16 * 1024, MAX_FRAME=64*1024;
    public static final Set<String> KINDS = Set.of("chat", "chat-control", "phone-data", "phone-control");
    private Protocol() {}
    public record Frame(int streamId, byte[] payload) {}
    public static byte[] encode(int streamId, byte[] value, int offset, int length) {
        if (streamId <= 0 || length < 1 || length > MAX_CHUNK) throw new IllegalArgumentException("Invalid frame");
        return ByteBuffer.allocate(HEADER_BYTES + length).order(ByteOrder.BIG_ENDIAN)
                .put((byte) VERSION).putInt(streamId).put(value, offset, length).array();
    }
    public static Frame decode(byte[] data) throws IOException {
        if (data.length <= HEADER_BYTES || data.length > MAX_FRAME + HEADER_BYTES || data[0] != VERSION)
            throw new IOException("Invalid tunnel frame");
        ByteBuffer buffer = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN); buffer.get();
        int id = buffer.getInt(); if (id <= 0) throw new IOException("Invalid stream ID");
        byte[] bytes = new byte[buffer.remaining()]; buffer.get(bytes); return new Frame(id, bytes);
    }
    public static boolean kindAllowed(String lane, String kind) {
        return "control".equals(lane) ? Set.of("phone-control", "chat-control").contains(kind)
                : "data".equals(lane) && Set.of("phone-data", "chat").contains(kind);
    }
    public static String id() { return UUID.randomUUID().toString(); }
}
