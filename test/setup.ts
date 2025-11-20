import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiAsPromised);

process.env.DO_NOT_TRACK = '1';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';  // Suppress logs during tests

export default chai;
