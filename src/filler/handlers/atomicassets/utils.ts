// The chain sends serialized_data as a hex string over SHIP snapshots and as a
// plain byte array over live deltas; normalize either shape to a Uint8Array
// before handing it to `deserialize`.
export function toByteArray(serializedData: string | number[] | Uint8Array): Uint8Array {
    if (typeof serializedData === 'string') {
        return Uint8Array.from(Buffer.from(serializedData, 'hex'));
    }

    return new Uint8Array(serializedData);
}
