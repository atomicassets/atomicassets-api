import 'mocha';
import {expect} from 'chai';

import {applyActionGreylistFilters, buildJsonbConditionVariants, extractNotificationIdentifiers, resolveTrustProxy, respondApiError} from './utils';
import {NotificationData} from '../filler/notifier';
import {ApiError} from './error';

describe('utils', () => {
    describe('ApplyActionGreyListFilters', () => {
        const action_whitelist = ['a', 'b', 'c'];
        const action_blacklist = ['c', 'd', 'e'];

        it('applies both white and black list filters on the actions', () => {
            expect(applyActionGreylistFilters(['a', 'b', 'c', 'd', 'e', 'f'], {action_blacklist, action_whitelist}))
                .to.deep.equal(['a', 'b']);
        });

        it('handles an empty action_whitelist', () => {
            expect(applyActionGreylistFilters(['a', 'b', 'c', 'd', 'e', 'f'], {action_blacklist, action_whitelist: []}))
                .to.deep.equal(['a', 'b', 'f']);
        });
    });

    describe('extractNotificationIdentifiers', () => {
        const key = 'key';
        const deltaNotification: NotificationData = {
            type: 'delta',
            data: {
                delta: {
                    value: {[key]: 'deltaNotificationVal'},
                } as any,
            } as any,
            channel: 'channel',
        };

        const traceNotification: NotificationData = {
            type: 'trace',
            data: {
                trace: {
                    act: {
                        data: {[key]: 'traceNotificationVal'},
                    },
                } as any,
            } as any,
            channel: 'channel',
        };

        it('extracts the notifications of type delta given key', () => {
            expect(extractNotificationIdentifiers([deltaNotification], key))
                .to.deep.equal(['deltaNotificationVal']);
        });

        it('extracts the notifications of type trace given key', () => {
            expect(extractNotificationIdentifiers([traceNotification], key))
                .to.deep.equal(['traceNotificationVal']);
        });

        it('ignores trace notification when no trace information is present', () => {
            const emptyTrace = {
                ...traceNotification,
                data: {
                    trace: undefined,
                } as any,
            };
            expect(extractNotificationIdentifiers([emptyTrace], key))
                .to.deep.equal([]);
        });

        it('ignores repeated identifiers', () => {
            expect(extractNotificationIdentifiers([deltaNotification, deltaNotification], key))
                .to.deep.equal(['deltaNotificationVal']);
        });
    });

    describe('buildJsonbConditionVariants', () => {
        it('emits numeric string values as JSON number tokens in the number variant', () => {
            expect(buildJsonbConditionVariants({sale_id: '172238298'}))
                .to.deep.equal(['{"sale_id":172238298}', '{"sale_id":"172238298"}']);
        });

        it('keeps the string variant quoted for asset_id (stored as JSON string >= 2^32)', () => {
            expect(buildJsonbConditionVariants({asset_id: '1099986167536'}))
                .to.deep.equal(['{"asset_id":1099986167536}', '{"asset_id":"1099986167536"}']);
        });

        it('preserves full precision for uint64 values that overflow JS Number', () => {
            expect(buildJsonbConditionVariants({asset_id: '18446744073709551615'}))
                .to.deep.equal(['{"asset_id":18446744073709551615}', '{"asset_id":"18446744073709551615"}']);
        });

        it('keeps eosio names quoted as strings in both variants', () => {
            expect(buildJsonbConditionVariants({collection_name: 'alien.worlds'}))
                .to.deep.equal(['{"collection_name":"alien.worlds"}', '{"collection_name":"alien.worlds"}']);
        });

        it('mixes numeric ids and string names correctly', () => {
            expect(buildJsonbConditionVariants({sale_id: '1', collection_name: 'alien.worlds'}))
                .to.deep.equal([
                    '{"sale_id":1,"collection_name":"alien.worlds"}',
                    '{"sale_id":"1","collection_name":"alien.worlds"}'
                ]);
        });

        it('handles negative integer strings', () => {
            expect(buildJsonbConditionVariants({offset: '-5'}))
                .to.deep.equal(['{"offset":-5}', '{"offset":"-5"}']);
        });

        it('handles empty conditions', () => {
            expect(buildJsonbConditionVariants({})).to.deep.equal(['{}', '{}']);
        });

        it('keeps non-integer numeric-looking strings as strings in both variants', () => {
            expect(buildJsonbConditionVariants({version: '1.2.3'}))
                .to.deep.equal(['{"version":"1.2.3"}', '{"version":"1.2.3"}']);
        });
    });

    describe('respondApiError', () => {
        const createMockResponse = (): { statusCalled: any[], jsonCalled: any[] } => {
            const response: any = {
                statusCalled: [],
                jsonCalled: [],
            };

            response['status'] = (...args: any[]): any => {
                response.statusCalled = args;
                return response;
            };

            response['json'] = (...args: any[]): any => {
                response.jsonCalled = args;
            };
            return response;
        };

        const apiError: ApiError = {
            code: 409,
            message: 'duplicated transaction',
            name: 'Duplicated',
            showMessage: true,
            stack: 'stack',
        };


        it('on unhandled error, formats to internal server error', () => {
            const mockResponse = createMockResponse();
            respondApiError(mockResponse as any, new Error('Unhandled error'));
            const returnedStatus = mockResponse.statusCalled[0];
            expect(returnedStatus).to.equal(500);
        });

        it('on api error handled error, shows the message and the code of the error', () => {
            const mockResponse = createMockResponse();
            respondApiError(mockResponse as any, apiError);
            const returnedStatus = mockResponse.statusCalled[0];
            expect(returnedStatus).to.deep.equal(apiError.code);
            const responseBody = mockResponse.jsonCalled[0];
            expect(responseBody).to.deep.equal({success: false, message: apiError.message});
        });

        it('on api error handled error, skip on sensitive information', () => {
            const mockResponse = createMockResponse();
            const noMessageShow = {...apiError, showMessage: false};
            respondApiError(mockResponse as any, noMessageShow);
            const returnedStatus = mockResponse.statusCalled[0];
            expect(returnedStatus).to.equal(500);
        });
    });

    describe('resolveTrustProxy', () => {
        it('maps true to a single trusted hop (historical behavior)', () => {
            expect(resolveTrustProxy(true)).to.equal(1);
        });

        it('passes false through (trust nothing)', () => {
            expect(resolveTrustProxy(false)).to.equal(false);
        });

        it('passes hop counts through verbatim', () => {
            expect(resolveTrustProxy(2)).to.equal(2);
        });

        it('passes named subnets through verbatim', () => {
            expect(resolveTrustProxy('loopback')).to.equal('loopback');
        });

        it('passes CIDR lists through verbatim', () => {
            const cidrs = ['loopback', '10.0.0.0/8', '172.64.0.0/13'];
            expect(resolveTrustProxy(cidrs)).to.deep.equal(cidrs);
        });
    });
});
