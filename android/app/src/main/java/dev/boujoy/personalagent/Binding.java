package dev.boujoy.personalagent;

import org.json.JSONObject;
import java.net.URI;
import java.time.Instant;

public final class Binding {
    public final String relayUrl, deviceId, routeToken, gatewayPin, pairToken, identityAlias;
    public final long expiresAt;
    public Binding(JSONObject value, boolean importing) {
        if(!BuildConfig.EDITION.equals(value.optString("edition")) || !BuildConfig.APPLICATION_ID.equals(value.optString("androidApplicationId")))
            throw new IllegalArgumentException("连接码版本不匹配，请使用同一发行版的电脑端和手机端");
        relayUrl = value.optString("relayUrl"); deviceId = value.optString("deviceId");
        routeToken = value.optString("routeToken"); gatewayPin = value.optString("gatewayPin");
        identityAlias=value.optString("identityAlias",DeviceIdentity.LEGACY_ALIAS);
        if(!java.util.Set.of(DeviceIdentity.LEGACY_ALIAS,DeviceIdentity.TLS_ALIAS).contains(identityAlias))throw new IllegalArgumentException("手机身份名称无效");
        pairToken = value.optString("pairToken"); expiresAt = parseTime(value.opt("expiresAt"));
        URI url = URI.create(relayUrl);
        if (!"wss".equals(url.getScheme()) || url.getHost() == null || !"/v1/tunnel".equals(url.getPath()) || url.getUserInfo() != null || url.getFragment() != null || url.getQuery() != null)
            throw new IllegalArgumentException("绑定地址必须为安全 WSS 地址");
        if (!deviceId.matches("[A-Za-z0-9_-]{8,128}") || routeToken.length() < 32 || routeToken.length() > 512)
            throw new IllegalArgumentException("绑定身份不完整");
        if (!gatewayPin.matches("(?:sha256/)?[A-Fa-f0-9]{64}") && !gatewayPin.matches("sha256/[A-Za-z0-9+/]{43}="))
            throw new IllegalArgumentException("电脑身份指纹无效");
        if (importing && (pairToken.length() < 24 || expiresAt <= System.currentTimeMillis()))
            throw new IllegalArgumentException("绑定码已过期，请在电脑上重新生成");
    }
    public static long parseTime(Object value) {
        if (value instanceof Number) return ((Number)value).longValue();
        try { return Instant.parse(String.valueOf(value)).toEpochMilli(); } catch (Exception ignored) { return 0; }
    }
    public String endpoint() { return relayUrl; }
}
