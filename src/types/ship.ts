import type {
    ShipActionTrace as PkgShipActionTrace,
    ShipContractRow as PkgShipContractRow,
    ShipTableDelta as PkgShipTableDelta
} from '@atomichub/antelope-ship-utils';

export type {
    ShipBlock,
    ShipBlockResponse,
    ShipTransactionTrace,
    ShipActionReceipt,
    ShipPartialTransaction
} from '@atomichub/antelope-ship-utils';

// The package generics stay as published. This file pins the defaults this
// service declared for the trace and row aliases (binary action data is a
// hex string on some paths here) and re-exports ShipTableDelta without a
// type parameter.
export type ShipActionTrace<T = string | Uint8Array> = PkgShipActionTrace<T>;
export type ShipContractRow<T = Uint8Array | string> = PkgShipContractRow<T>;
export type ShipTableDelta = PkgShipTableDelta;
