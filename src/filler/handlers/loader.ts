import { ContractHandler } from './interfaces';

import AtomicAssetsHandler from './atomicassets';
import AtomicDropsHandler from './atomicdropsx';
import AtomicMarketHandler from './atomicmarket';
import AtomicPacksHandler from './atomicpacksx';
import AtomicToolsHandler from './atomictools';
import DelphiOracleHandler from './delphioracle';
import SimpleAssetsHandler from './simpleassets';

export const handlers: (typeof ContractHandler)[] = [
    AtomicAssetsHandler,
    AtomicDropsHandler,
    AtomicMarketHandler,
    AtomicPacksHandler,
    AtomicToolsHandler,
    DelphiOracleHandler,
    SimpleAssetsHandler
];
