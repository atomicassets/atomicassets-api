import express from 'express';

import { AtomicAssetsContext, AtomicAssetsNamespace } from '../index';
import { HTTPServer } from '../../../server';
import { RequestValues } from '../../utils';
import { FillerHook, fillMoves } from '../filler';
import {
    dateBoundaryParameters,
    getOpenAPI3Responses,
    getPrimaryBoundaryParams,
    paginationParameters
} from '../../../docs';
import { greylistFilterParameters } from '../openapi';
import ApiNotificationReceiver from '../../../notification';
import { createSocketApiNamespace } from '../../../utils';
import { NotificationData } from '../../../../filler/notifier';
import { getRawMovesAction, getMovesCountAction } from '../handlers/moves';

export class MoveApi {
    constructor(
        readonly core: AtomicAssetsNamespace,
        readonly server: HTTPServer,
        readonly schema: string,
        readonly moveView: string,
        readonly moveFormatter: (_: any) => any,
        readonly assetView: string,
        readonly assetFormatter: (_: any) => any,
        readonly fillerHook?: FillerHook
    ) { }

    getMovesAction = async (params: RequestValues, ctx: AtomicAssetsContext): Promise<any> => {
        const result = await getRawMovesAction(params, ctx);

        return await fillMoves(
            this.server, this.core.args.atomicassets_account,
            result.rows.map(this.moveFormatter),
            this.assetFormatter, this.assetView, this.fillerHook
        );
    };

    endpoints(router: express.Router): any {
        const {caching, returnAsJSON} = this.server.web;

        router.all('/v1/moves', caching(), returnAsJSON(this.getMovesAction, this.core));
        router.all('/v1/moves/_count', caching(), returnAsJSON(getMovesCountAction, this.core));

        return {
            tag: {
                name: 'moves',
                description: 'Moves'
            },
            paths: {
                '/v1/moves': {
                    get: {
                        tags: ['moves'],
                        summary: 'Fetch moves',
                        parameters: [
                            {
                                name: 'account',
                                in: 'query',
                                description: 'Notified account (can be sender or recipient) - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'sender',
                                in: 'query',
                                description: 'Move sender - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'recipient',
                                in: 'query',
                                description: 'Move recipient - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'memo',
                                in: 'query',
                                description: 'Search for exact memo',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'match_memo',
                                in: 'query',
                                description: 'Search for text in memo',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'asset_id',
                                in: 'query',
                                description: 'only moves which contain this asset_id - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'template_id',
                                in: 'query',
                                description: 'only moves which contain assets of this template - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'schema_name',
                                in: 'query',
                                description: 'only moves which contain assets of this schema - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'collection_name',
                                in: 'query',
                                description: 'only moves which contain assets of this collection - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'hide_contracts',
                                in: 'query',
                                description: 'dont show moves from or to accounts that have code deployed',
                                required: false,
                                schema: {type: 'boolean'}
                            },
                            ...getPrimaryBoundaryParams('move_id'),
                            ...dateBoundaryParameters,
                            ...greylistFilterParameters,
                            ...paginationParameters,
                            {
                                name: 'sort',
                                in: 'query',
                                description: 'Column to sort',
                                required: false,
                                schema: {
                                    type: 'string',
                                    enum: ['created'],
                                    default: 'created'
                                }
                            }
                        ],
                        responses: getOpenAPI3Responses([200, 500], {type: 'array', items: {'$ref': '#/components/schemas/' + this.schema}})
                    }
                }
            }
        };
    }

    sockets(notification: ApiNotificationReceiver): void {
        const namespace = createSocketApiNamespace(this.server, this.core.path + '/v1/moves');

        notification.onData('moves', async (notifications: NotificationData[]) => {
            const moveIDs = notifications.filter(row => row.type === 'trace').map(row => row.data.trace.global_sequence);
            const query = await this.server.database.query(
                'SELECT * FROM ' + this.moveView + ' WHERE contract = $1 AND move_id = ANY($2)',
                [this.core.args.atomicassets_account, moveIDs]
            );

            const moves = await fillMoves(
                this.server, this.core.args.atomicassets_account,
                query.rows.map((row) => this.moveFormatter(row)),
                this.assetFormatter, this.assetView, this.fillerHook
            );

            for (const notification of notifications) {
                if (notification.type === 'trace' && notification.data.trace) {
                    const trace = notification.data.trace;

                    if (trace.act.account !== this.core.args.atomicassets_account) {
                        continue;
                    }

                    if (trace.act.name === 'logmove') {
                        namespace.emit('new_move', {
                            transaction: notification.data.tx,
                            block: notification.data.block,
                            trace: trace,
                            move_id: trace.global_sequence,
                            move: moves.find(row => String(row.move_id) === String(trace.global_sequence))
                        });
                    }
                } else if (notification.type === 'fork') {
                    namespace.emit('fork', {block_num: notification.data.block.block_num});
                }
            }
        });
    }
}
