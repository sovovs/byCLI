/** @typedef {{token: string, cookie: string, fingerprint?: string}} WechatCredentials */
/** @typedef {{value: string, cookieNames: ReadonlySet<string>}} SecretCandidate */

const REDACTION = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';
const FUNCTION = '[FUNCTION]';
const BIGINT = '[BIGINT]';
const SYMBOL = '[SYMBOL]';
const UNDEFINED = '[UNDEFINED]';
const NON_FINITE_NUMBER = '[NON_FINITE_NUMBER]';
const LONG_SECRET_LENGTH = 8;
function isSafeSecret(value) {
    return typeof value === 'string' && value.length > 0;
}
function cookieValues(cookie) {
    return cookie.split(';').flatMap(part => {
        const separator = part.indexOf('=');
        if (separator < 0)
            return [];
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        return isSafeSecret(value) ? [{ name, value }] : [];
    });
}
function normalizeSecrets(secrets) {
    return [...new Set(secrets.filter(isSafeSecret))].sort((left, right) => {
        const byLength = right.length - left.length;
        return byLength === 0 ? left.localeCompare(right) : byLength;
    });
}
/** @param {WechatCredentials} credentials @returns {string[]} */
export function buildSecretSet(credentials) {
    const rawSecrets = [
        credentials.token,
        credentials.cookie,
        credentials.fingerprint,
        ...cookieValues(credentials.cookie).map(({ value }) => value),
    ].filter(isSafeSecret);
    return normalizeSecrets(rawSecrets.flatMap(value => [value, encodeURIComponent(value)]));
}
function percentCanonical(value) {
    return value.replace(/%[\da-f]{2}/gi, escape => escape.toUpperCase());
}
function matchesAt(value, index, candidate) {
    if (index + candidate.length > value.length)
        return false;
    for (let offset = 0; offset < candidate.length; offset += 1) {
        if (candidate[offset] === '%' &&
            offset + 2 < candidate.length &&
            /^[\da-f]{2}$/i.test(candidate.slice(offset + 1, offset + 3))) {
            const inputEscape = value.slice(index + offset, index + offset + 3);
            if (!/^%[\da-f]{2}$/i.test(inputEscape))
                return false;
            if (inputEscape.toUpperCase() !== candidate.slice(offset, offset + 3).toUpperCase()) {
                return false;
            }
            offset += 2;
            continue;
        }
        if (value[index + offset] !== candidate[offset])
            return false;
    }
    return true;
}
function candidateList(secrets) {
    const normalized = normalizeSecrets(secrets);
    const cookieNamesByValue = new Map();
    for (const secret of normalized) {
        let representations = [secret];
        try {
            const decoded = decodeURIComponent(secret);
            if (decoded !== secret)
                representations = [secret, decoded];
        }
        catch {
            // A malformed percent escape is still a valid literal secret.
        }
        for (const representation of representations) {
            for (const { name, value } of cookieValues(representation)) {
                if (!name)
                    continue;
                for (const variant of [value, encodeURIComponent(value)]) {
                    const canonical = percentCanonical(variant);
                    const names = cookieNamesByValue.get(canonical) ?? new Set();
                    names.add(name.toLowerCase());
                    cookieNamesByValue.set(canonical, names);
                }
            }
        }
    }
    const byCanonicalValue = new Map();
    for (const value of normalized) {
        const canonical = percentCanonical(value);
        const cookieNames = cookieNamesByValue.get(canonical) ?? new Set();
        const existing = byCanonicalValue.get(canonical);
        if (existing) {
            byCanonicalValue.set(canonical, {
                value: existing.value,
                cookieNames: new Set([...existing.cookieNames, ...cookieNames]),
            });
        }
        else {
            byCanonicalValue.set(canonical, { value, cookieNames });
        }
    }
    return [...byCanonicalValue.values()].sort((left, right) => {
        const byLength = right.value.length - left.value.length;
        return byLength === 0 ? left.value.localeCompare(right.value) : byLength;
    });
}
function isGlobalCandidate(value) {
    if (value.length >= LONG_SECRET_LENGTH)
        return true;
    if (value.length < 4)
        return false;
    const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^\w]/.test(value)];
    return classes.every(Boolean);
}
function isSensitiveKey(key) {
    return /^(?:access[-_.]?token|api[-_.]?key|authorization|cookie|fingerprint|password|secret|token)$/i.test(key);
}
function hasTokenBoundaries(value, index, length) {
    const before = value[index - 1];
    const after = value[index + length];
    const isBoundary = (character) => character === undefined || /[\s&;,|()[\]{}<>"']/u.test(character);
    return isBoundary(before) && isBoundary(after);
}
function isCompleteAssignment(candidate) {
    return /^[\w.-]+(?:=|%3d).+/i.test(candidate);
}
function isWhitespace(character) {
    return character !== undefined && /\s/u.test(character);
}
function buildTextContext(input) {
    let standaloneStart = 0;
    while (standaloneStart < input.length && isWhitespace(input[standaloneStart])) {
        standaloneStart += 1;
    }
    let standaloneEnd = input.length;
    while (standaloneEnd > standaloneStart && isWhitespace(input[standaloneEnd - 1])) {
        standaloneEnd -= 1;
    }
    const assignmentKeys = new Map();
    for (let start = 0; start < input.length; start += 1) {
        if (start > 0 && !/[?&;,\s]/u.test(input[start - 1]))
            continue;
        if (!/[\w.-]/u.test(input[start]))
            continue;
        let cursor = start;
        while (cursor < input.length && /[\w.-]/u.test(input[cursor]))
            cursor += 1;
        const key = input.slice(start, cursor).toLowerCase();
        while (cursor < input.length && isWhitespace(input[cursor]))
            cursor += 1;
        if (input[cursor] !== '=' && input[cursor] !== ':')
            continue;
        cursor += 1;
        while (cursor < input.length && isWhitespace(input[cursor]))
            cursor += 1;
        assignmentKeys.set(cursor, key);
    }
    const cookieValueEnds = new Map();
    let lineStart = 0;
    while (lineStart < input.length) {
        const newline = input.indexOf('\n', lineStart);
        const lineEnd = newline < 0 ? input.length : newline;
        const line = input.slice(lineStart, lineEnd);
        const header = /^\s*(?:cookie|set-cookie)\s*:\s*/iu.exec(line);
        if (header) {
            let segmentStart = header[0].length;
            while (segmentStart < line.length) {
                const separator = line.indexOf(';', segmentStart);
                const segmentEnd = separator < 0 ? line.length : separator;
                const equals = line.indexOf('=', segmentStart);
                if (equals >= 0 && equals < segmentEnd) {
                    let valueStart = equals + 1;
                    while (valueStart < segmentEnd && isWhitespace(line[valueStart]))
                        valueStart += 1;
                    let valueEnd = valueStart;
                    while (valueEnd < segmentEnd &&
                        !isWhitespace(line[valueEnd]) &&
                        line[valueEnd] !== ',') {
                        valueEnd += 1;
                    }
                    if (valueEnd > valueStart) {
                        cookieValueEnds.set(lineStart + valueStart, lineStart + valueEnd);
                    }
                }
                if (separator < 0)
                    break;
                segmentStart = separator + 1;
            }
        }
        if (newline < 0)
            break;
        lineStart = newline + 1;
    }
    return { standaloneStart, standaloneEnd, assignmentKeys, cookieValueEnds };
}
function mayRedactCandidate(input, index, candidate, context) {
    if (isGlobalCandidate(candidate.value))
        return true;
    if (index === context.standaloneStart &&
        index + candidate.value.length === context.standaloneEnd) {
        return true;
    }
    if (context.cookieValueEnds.get(index) === index + candidate.value.length)
        return true;
    const assignmentKey = context.assignmentKeys.get(index);
    if (assignmentKey) {
        if (isSensitiveKey(assignmentKey))
            return true;
        if (candidate.cookieNames.has(assignmentKey))
            return true;
    }
    if (isCompleteAssignment(candidate.value) && hasTokenBoundaries(input, index, candidate.value.length)) {
        return true;
    }
    return false;
}
function stringifyWithoutHooks(value) {
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
        return REDACTION;
    }
    return String(value);
}
/** @param {unknown} value @param {readonly string[]} secrets @returns {string} */
export function redactText(value, secrets) {
    const candidates = candidateList(secrets);
    return redactTextWithCandidates(value, candidates);
}
function redactTextWithCandidates(value, candidates) {
    const input = stringifyWithoutHooks(value);
    if (candidates.length === 0)
        return input;
    const context = buildTextContext(input);
    const pieces = [];
    let unchangedStart = 0;
    let index = 0;
    while (index < input.length) {
        const candidate = candidates.find(item => matchesAt(input, index, item.value) &&
            mayRedactCandidate(input, index, item, context));
        if (!candidate) {
            index += 1;
            continue;
        }
        pieces.push(input.slice(unchangedStart, index), REDACTION);
        index += candidate.value.length;
        unchangedStart = index;
    }
    pieces.push(input.slice(unchangedStart));
    return pieces.join('');
}
function containsCandidate(value, candidates) {
    for (let index = 0; index < value.length; index += 1) {
        if (candidates.some(candidate => matchesAt(value, index, candidate.value)))
            return true;
    }
    return false;
}
function collisionSafeKey(target, key) {
    if (!Object.prototype.hasOwnProperty.call(target, key))
        return key;
    if (typeof key === 'symbol')
        return Symbol();
    let suffix = 2;
    let candidate = `${key}_${suffix}`;
    while (Object.prototype.hasOwnProperty.call(target, candidate)) {
        suffix += 1;
        candidate = `${key}_${suffix}`;
    }
    return candidate;
}
function copyRedactedDescriptors(descriptors, target, candidates, seen, active, skippedKeys = new Set()) {
    for (const key of Reflect.ownKeys(descriptors)) {
        if (skippedKeys.has(key))
            continue;
        const descriptor = descriptors[key];
        if (!descriptor)
            continue;
        let safeKey = key;
        if (typeof key === 'string') {
            if (containsCandidate(key, candidates))
                safeKey = REDACTION;
        }
        else if (key.description !== undefined) {
            if (containsCandidate(key.description, candidates))
                safeKey = Symbol();
        }
        safeKey = collisionSafeKey(target, safeKey);
        if ('value' in descriptor) {
            Object.defineProperty(target, safeKey, {
                configurable: true,
                enumerable: descriptor.enumerable ?? false,
                writable: true,
                value: redactRecursive(descriptor.value, candidates, seen, active),
            });
        }
        else {
            Object.defineProperty(target, safeKey, {
                configurable: true,
                enumerable: descriptor.enumerable ?? false,
                writable: true,
                value: REDACTION,
            });
        }
    }
}
function hasErrorPrototype(value) {
    const visited = new Set();
    let prototype = Object.getPrototypeOf(value);
    while (prototype !== null && !visited.has(prototype)) {
        if (prototype === Error.prototype)
            return true;
        visited.add(prototype);
        prototype = Object.getPrototypeOf(prototype);
    }
    return false;
}
function inheritedErrorString(value, key) {
    const visited = new Set();
    let prototype = Object.getPrototypeOf(value);
    while (prototype !== null && !visited.has(prototype)) {
        visited.add(prototype);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
            return descriptor.value;
        }
        prototype = Object.getPrototypeOf(prototype);
    }
    return '';
}
function defineErrorDefaults(source, descriptors, target, candidates) {
    for (const key of ['name', 'message']) {
        if (Object.prototype.hasOwnProperty.call(descriptors, key))
            continue;
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: false,
            writable: true,
            value: redactTextWithCandidates(inheritedErrorString(source, key), candidates),
        });
    }
}
function redactRecursive(value, candidates, seen, active) {
    if (typeof value === 'string')
        return redactTextWithCandidates(value, candidates);
    if (typeof value === 'function')
        return FUNCTION;
    if (typeof value === 'bigint')
        return BIGINT;
    if (typeof value === 'symbol')
        return SYMBOL;
    if (typeof value === 'undefined')
        return UNDEFINED;
    if (typeof value === 'number' && !Number.isFinite(value))
        return NON_FINITE_NUMBER;
    if (!value || typeof value !== 'object')
        return value;
    if (active.has(value))
        return CIRCULAR;
    if (seen.has(value))
        return seen.get(value);
    try {
        const array = Array.isArray(value);
        const error = !array && hasErrorPrototype(value);
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const lengthDescriptor = descriptors.length;
        const arrayLength = array && lengthDescriptor && 'value' in lengthDescriptor && typeof lengthDescriptor.value === 'number'
            ? lengthDescriptor.value
            : 0;
        const output = array ? new Array(arrayLength) : Object.create(null);
        seen.set(value, output);
        active.add(value);
        if (error)
            defineErrorDefaults(value, descriptors, output, candidates);
        copyRedactedDescriptors(descriptors, output, candidates, seen, active, array ? new Set(['length']) : undefined);
        active.delete(value);
        return output;
    }
    catch {
        active.delete(value);
        seen.set(value, REDACTION);
        return REDACTION;
    }
}
/** @param {unknown} value @param {readonly string[]} secrets @returns {unknown} */
export function redactValue(value, secrets) {
    const candidates = candidateList(secrets);
    return redactRecursive(value, candidates, new WeakMap(), new WeakSet());
}
