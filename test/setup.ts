import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

// Configure Chai
chai.use(chaiAsPromised);

// Global test configuration
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';  // Suppress logs during tests

export default chai;
