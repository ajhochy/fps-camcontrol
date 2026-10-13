"""Strict, bounded v1 metadata protocol. This module has no vision imports."""
import json
import math
import re
import uuid
from urllib.parse import unquote, urlsplit

MAX_MESSAGE_BYTES = 65536
MAX_SAFE_INTEGER = 9007199254740991


def _keys(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise ValueError('invalid_message')


def _text(value, limit=128):
    if not isinstance(value, str) or not 1 <= len(value) <= limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('invalid_message')
    return value


def _number(value, minimum=0, maximum=1):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError('invalid_message')
    return value


def _integer(value):
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise ValueError('invalid_message')
    return value


def _session(value):
    _text(value, 36)
    try:
        if str(uuid.UUID(value)) != value.lower():
            raise ValueError('invalid_message')
    except (ValueError, AttributeError):
        raise ValueError('invalid_message') from None


def validate_origin(origin):
    if not isinstance(origin, str) or not re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}', origin):
        raise ValueError('invalid_backend_origin')
    if urlsplit(origin).port > 65535:
        raise ValueError('invalid_backend_origin')
    return origin


def validate_frame_url(url, backend_origin):
    validate_origin(backend_origin)
    if not isinstance(url, str) or len(url) > 2048:
        raise ValueError('invalid_frame_url')
    parsed = urlsplit(url)
    if parsed.scheme + '://' + parsed.netloc != backend_origin or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError('invalid_frame_url')
    match = re.fullmatch(r'/api/sony/cameras/([^/]+)/live-view/frame', parsed.path)
    if not match or not re.fullmatch(r'[A-Za-z0-9:-]{1,128}', unquote(match.group(1))):
        raise ValueError('invalid_frame_url')
    return url


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('invalid_message')
        result[key] = value
    return result


def parse_message(raw, backend_origin):
    if not isinstance(raw, str):
        raise ValueError('invalid_message')
    try:
        if len(raw.encode('utf8')) > MAX_MESSAGE_BYTES:
            raise ValueError('invalid_message')
        message = json.loads(raw, object_pairs_hook=_unique_pairs,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid_message')))
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError('invalid_message') from None
    if not isinstance(message, dict) or type(message.get('protocol')) is not int or message['protocol'] != 1:
        raise ValueError('invalid_message')
    kind = message.get('type')
    if kind == 'hello':
        _keys(message, ('type', 'protocol'))
    elif kind == 'ping':
        _keys(message, ('type', 'protocol', 'nonce')); _text(message['nonce'])
    elif kind == 'configure':
        _keys(message, ('type', 'protocol', 'sources'))
        sources = message['sources']
        if not isinstance(sources, list) or len(sources) > 64:
            raise ValueError('invalid_message')
        ids, urls = set(), set()
        for source in sources:
            _keys(source, ('sourceId', 'frameUrl'))
            source_id = _text(source['sourceId'])
            url = validate_frame_url(source['frameUrl'], backend_origin)
            if source_id in ids or url in urls:
                raise ValueError('invalid_message')
            ids.add(source_id); urls.add(url)
    elif kind in ('select', 'cancel'):
        _keys(message, ('type', 'protocol', 'sourceId', 'sessionId') + (('x', 'y') if kind == 'select' else ()))
        _text(message['sourceId']); _session(message['sessionId'])
        if kind == 'select':
            _number(message['x']); _number(message['y'])
    else:
        raise ValueError('invalid_message')
    return message


def validate_outgoing(message):
    if type(message.get('protocol')) is not int or message['protocol'] != 1:
        raise ValueError('invalid_message')
    kind = message.get('type')
    if kind == 'hello':
        _keys(message, ('protocol', 'type', 'version', 'capabilities', 'detector', 'provider', 'degradedTiming'))
        for key in ('version', 'detector', 'provider'): _text(message[key], 128)
        if message['capabilities'] != ['person'] or type(message['degradedTiming']) is not bool: raise ValueError('invalid_message')
    elif kind == 'pong':
        _keys(message, ('protocol', 'type', 'nonce')); _text(message['nonce'])
    elif kind == 'error':
        _keys(message, ('protocol', 'type', 'code', 'message'), ('sourceId', 'sessionId'))
        _text(message['code'], 64); _text(message['message'], 256)
        if 'sourceId' in message: _text(message['sourceId'])
        if 'sessionId' in message: _session(message['sessionId'])
    elif kind == 'status':
        _keys(message, ('protocol', 'type', 'sourceId', 'fps', 'dropped', 'busy', 'detectP50Ms', 'detectP95Ms', 'frameAgeMs', 'degradedTiming'))
        _text(message['sourceId']); _integer(message['dropped']); _integer(message['busy'])
        for key in ('fps', 'detectP50Ms', 'detectP95Ms', 'frameAgeMs'): _number(message[key], 0, MAX_SAFE_INTEGER)
        if type(message['degradedTiming']) is not bool: raise ValueError('invalid_message')
    elif kind == 'track':
        _keys(message, ('protocol', 'type', 'sourceId', 'sessionId', 'seq', 'state', 'cx', 'cy', 'w', 'h', 'conf', 'frameTs', 'processedAt'))
        _text(message['sourceId']); _session(message['sessionId']); _integer(message['seq'])
        _integer(message['frameTs']); _integer(message['processedAt'])
        if message['processedAt'] < message['frameTs']: raise ValueError('invalid_message')
        if message['state'] not in ('locking', 'tracking', 'lost', 'idle'): raise ValueError('invalid_message')
        for key in ('cx', 'cy', 'w', 'h', 'conf'): _number(message[key])
        if message['state'] == 'tracking':
            if min(message['w'], message['h'], message['conf']) <= 0: raise ValueError('invalid_message')
        elif message['conf'] != 0: raise ValueError('invalid_message')
        if message['cx'] - message['w']/2 < -1e-9 or message['cx'] + message['w']/2 > 1+1e-9 or message['cy'] - message['h']/2 < -1e-9 or message['cy'] + message['h']/2 > 1+1e-9:
            raise ValueError('invalid_message')
    else: raise ValueError('invalid_message')
    return message


def encode(message):
    return json.dumps(validate_outgoing(message), separators=(',', ':'), allow_nan=False)
