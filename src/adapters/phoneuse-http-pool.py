"""Bounded HTTP keep-alive for the cloud-only, pinned official bridge.

The official Connection validates each result against a pinned device and
service identity. Every new TLS connection verifies the public-key pin.
"""

def install_pool(source, connection_class):
    import atexit
    import hmac
    import http.client
    import json
    import ssl
    import threading
    import time
    from urllib.parse import urlsplit

    local = threading.local()
    sockets = set()
    sockets_lock = threading.Lock()
    globals_ = source['http_request'].__globals__

    def discard(connection):
        connection.close()
        with sockets_lock:
            sockets.discard(connection)

    def close_all():
        with sockets_lock:
            remaining = list(sockets)
            sockets.clear()
        for connection in remaining:
            connection.close()

    atexit.register(close_all)

    def http_request(config, endpoint, payload=None, authenticate=True, method='POST'):
        origin = source['origin'](config['url'])
        url = urlsplit(origin)
        pin = config.get('tls_pin')
        bootstrap = config.get('_bootstrap') and endpoint == '/identity' and method == 'GET' and not authenticate
        if not pin and not bootstrap:
            raise source['BridgeError']('TLS_PAIRING_REQUIRED', 'Explicit pinned pairing is required', action_executed=False)
        if pin:
            source['checked_hex'](pin)

        # Pairing probes are never pooled. Each thread is the official per-device
        # queue; data and control run in distinct processes and cannot head-block.
        key = (origin, pin)
        # HTTP close is controlled by the phone. A TLS ticket can still resume
        # the next connection, without replaying any HTTP request or action.
        tls_state = getattr(local, 'tls_state', None)
        if not tls_state or tls_state['key'] != key:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE  # authenticated by explicit SPKI below
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            tls_state = dict(key=key, context=context, session=None)
            local.tls_state = tls_state
        cached = getattr(local, 'connection', None)
        if cached and (cached[0] != key or time.monotonic() - cached[2] > 25):
            discard(cached[1])
            local.connection = None
            cached = None
        if endpoint == '/identity':
            local.metrics = dict(httpRequests=0, tlsHandshakes=0, receivedBytes=0, durationMs=0)
        metrics = getattr(local, 'metrics', dict(httpRequests=0, tlsHandshakes=0, receivedBytes=0, durationMs=0))
        local.metrics = metrics
        started = time.monotonic()
        tool = (payload or {}).get('tool') if endpoint == '/api' else ((payload or {}).get('params') or {}).get('name')
        timeout = 90 if tool == 'observe' else 25
        if cached:
            connection = cached[1]
            connection.timeout = timeout
        else:
            class ResumableConnection(connection_class):
                def connect(self):
                    http.client.HTTPConnection.connect(self)
                    hostname = self._tunnel_host or self.host
                    self.sock = self._context.wrap_socket(self.sock, server_hostname=hostname,
                                                         session=tls_state['session'] if pin else None)
            connection = ResumableConnection(url.hostname, url.port or 8443,
                                             context=tls_state['context'], timeout=timeout)
            # A lost socket must fail this request, not reconnect underneath a
            # credential-bearing send after the explicit peer-pin check.
            connection.auto_open = 0
            with sockets_lock:
                sockets.add(connection)
        try:
            if connection.sock is None:
                connection.connect()
                metrics['tlsHandshakes'] += 1
                metrics['tlsResumed'] = metrics.get('tlsResumed', 0) + int(connection.sock.session_reused)
            connection.sock.settimeout(timeout)
            actual_pin = source['public_key_pin'](connection.sock.getpeercert(binary_form=True))
            if pin and not hmac.compare_digest(pin, actual_pin):
                raise source['BridgeError']('TLS_IDENTITY_MISMATCH', 'Phone TLS key changed; no credentials sent', action_executed=False)
            headers = {'Accept': 'application/json, text/event-stream'}
            if payload is not None:
                headers['Content-Type'] = 'application/json'
            if authenticate:
                headers['Authorization'] = 'Bearer ' + config['token']
            if endpoint == '/mcp':
                headers['MCP-Protocol-Version'] = '2025-11-25'
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None
            metrics['httpRequests'] += 1
            connection.request(method, endpoint, body, headers)
            peer_socket = connection.sock
            response = connection.getresponse()
            # Headers have been read: TLS 1.3 session tickets preceding the
            # response are now available, including on Connection: close peers.
            session = peer_socket.session
            if pin and session and session.has_ticket:
                tls_state['session'] = session
            body = response.read(16 * 1024 * 1024 + 1)
            metrics['receivedBytes'] += len(body)
            if len(body) > 16 * 1024 * 1024:
                raise ValueError('Response too large')
            metrics['peerKeepAlive'] = not response.will_close
            if response.will_close or not pin:
                discard(connection)
                local.connection = None
            else:
                local.connection = (key, connection, time.monotonic())
            if response.status == 202 and not body:
                return None
            value = json.loads(body)
            if not isinstance(value, dict):
                raise ValueError('Expected a JSON object from the phone')
            if response.status not in (200, 202):
                raise source['HttpError'](response.status, value)
            if endpoint == '/identity':
                value['_tls_pin'] = actual_pin
            if endpoint == '/mcp' and isinstance(value.get('result'), dict):
                metrics['durationMs'] += round((time.monotonic() - started) * 1000)
                # This is local transport telemetry, outside the signed/native
                # tool payload. It never participates in execution proof.
                value['result']['_boujoyTransport'] = dict(metrics)
            else:
                metrics['durationMs'] += round((time.monotonic() - started) * 1000)
            return value
        except Exception:
            tls_state['session'] = None
            discard(connection)
            local.connection = None
            raise

    globals_['http_request'] = http_request

    # The peer closes every connection, so each /identity probe costs a full TLS
    # round trip. Every new connection still re-checks the TLS pin above, and the
    # cached service_instance_id travels with each call so the phone itself
    # rejects a restarted service. Transport and unexpected errors drop the cache.
    identify = source['identify']
    identities = {}
    identities_lock = threading.Lock()

    def cached_identify(address, tls_pin=None):
        local.metrics = dict(httpRequests=0, tlsHandshakes=0, receivedBytes=0, durationMs=0)
        if not tls_pin:
            return identify(address, tls_pin)
        key = (address, tls_pin)
        with identities_lock:
            cached = identities.get(key)
            if cached and time.monotonic() - cached[1] <= 20:
                local.call_identity = dict(cached[0])
                return dict(local.call_identity)
        value = identify(address, tls_pin)
        with identities_lock:
            identities[key] = (dict(value), time.monotonic())
        local.call_identity = dict(value)
        return value

    def forget_identities():
        with identities_lock:
            identities.clear()

    globals_['identify'] = cached_identify
    connection_type = source['Connection']
    send_locked = connection_type._send_locked

    def known_unknown_status(device_id, endpoint, payload, result):
        # The official client has checked the TLS pin, JSON-RPC id and all
        # supplied identities. Only an exact read of this request may retain
        # its original 20-second identity cache entry (never renew its TTL).
        identity = getattr(local, 'call_identity', None)
        if not identity or identity.get('device_id') != device_id or endpoint != '/mcp' or result.get('isError') is not True:
            return False
        params = payload.get('params', {})
        args = params.get('arguments', {})
        request_id = args.get('request_id')
        if payload.get('method') != 'tools/call' or params.get('name') != 'get_status' or not isinstance(request_id, str) or not request_id:
            return False
        contents = result.get('content')
        if not isinstance(contents, list) or len(contents) != 1 or not isinstance(contents[0], dict) or contents[0].get('type') != 'text':
            return False
        try:
            row = json.loads(contents[0]['text'])
        except (KeyError, ValueError, TypeError):
            return False
        instance = identity.get('service_instance_id')
        if not isinstance(row, dict) or not instance or row.get('device_id') != device_id or row.get('service_instance_id') != instance:
            return False
        if row.get('paused', False) is not False or row.get('stopped', False) is not False or row.get('executing_request_id') is not None:
            return False
        error, request = row.get('error'), row.get('request')
        if isinstance(error, dict):
            return error.get('code') == 'REQUEST_NOT_FOUND' and request is None and row.get('request_id', request_id) == request_id
        return (error is None and isinstance(request, dict) and row.get('stopped') is False
                and 'executing_request_id' in row and request.get('request_id') == request_id
                and request.get('device_id') == device_id and request.get('service_instance_id') == instance
                and request.get('state') == 'unknown' and 'action_executed' in request and request['action_executed'] is None
                and isinstance(request.get('error'), dict) and request['error'].get('code') == 'RESULT_UNKNOWN')

    def guarded_send(self, device_id, endpoint, payload):
        local.call_identity = None
        try:
            value = send_locked(self, device_id, endpoint, payload)
        except Exception:
            forget_identities()
            raise
        result = value.get('result') if isinstance(value, dict) else None
        if isinstance(value, dict) and 'error' in value:
            forget_identities()
        elif isinstance(result, dict) and result.get('isError') and not known_unknown_status(device_id, endpoint, payload, result):
            forget_identities()
        return value

    connection_type._send_locked = guarded_send
