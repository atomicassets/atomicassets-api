import 'mocha';
import {expect} from 'chai';

import {applyActionGreylistFilters, buildJsonbCondition, extractNotificationIdentifiers, respondApiError} from './utils';
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

    describe('buildJsonbCondition', () => {
        it('emits numeric string values as JSON number tokens', () => {
            expect(buildJsonbCondition({sale_id: '172238298'}))
                .to.equal('{"sale_id":172238298}');
        });

        it('preserves full precision for uint64 values that overflow JS Number', () => {
            expect(buildJsonbCondition({asset_id: '18446744073709551615'}))
                .to.equal('{"asset_id":18446744073709551615}');
        });

        it('keeps eosio names quoted as strings', () => {
            expect(buildJsonbCondition({collection_name: 'alien.worlds'}))
                .to.equal('{"collection_name":"alien.worlds"}');
        });

        it('mixes numeric ids and string names correctly', () => {
            expect(buildJsonbCondition({sale_id: '1', collection_name: 'alien.worlds'}))
                .to.equal('{"sale_id":1,"collection_name":"alien.worlds"}');
        });

        it('handles negative integer strings', () => {
            expect(buildJsonbCondition({offset: '-5'}))
                .to.equal('{"offset":-5}');
        });

        it('handles empty conditions', () => {
            expect(buildJsonbCondition({})).to.equal('{}');
        });

        it('keeps non-integer numeric-looking strings as strings', () => {
            expect(buildJsonbCondition({version: '1.2.3'}))
                .to.equal('{"version":"1.2.3"}');
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
});
