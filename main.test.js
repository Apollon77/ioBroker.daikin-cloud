'use strict';

/**
 * This is a dummy TypeScript test file using chai and mocha
 *
 * It's automatically excluded from npm and its build output is excluded from both git and npm.
 * It is advised to test all your modules with accompanying *.test.js-files
 */

// tslint:disable:no-unused-expression

const { expect } = require('chai');
const { normalizeOutdoorTemperature } = require('./lib/tools');

describe('lib/tools => normalizeOutdoorTemperature', () => {
    it('should convert uint8 underflow values (200..255) to negative temperatures', () => {
        expect(normalizeOutdoorTemperature(255)).to.equal(-1);
        expect(normalizeOutdoorTemperature(254)).to.equal(-2);
        expect(normalizeOutdoorTemperature(253)).to.equal(-3);
        expect(normalizeOutdoorTemperature(200)).to.equal(-56);
    });

    it('should keep valid temperatures and non-numeric values unchanged', () => {
        expect(normalizeOutdoorTemperature(0)).to.equal(0);
        expect(normalizeOutdoorTemperature(-5)).to.equal(-5);
        expect(normalizeOutdoorTemperature(25.5)).to.equal(25.5);
        expect(normalizeOutdoorTemperature(199)).to.equal(199);
        expect(normalizeOutdoorTemperature(256)).to.equal(256);
        expect(normalizeOutdoorTemperature(null)).to.equal(null);
        expect(normalizeOutdoorTemperature(undefined)).to.equal(undefined);
        expect(normalizeOutdoorTemperature('255')).to.equal('255');
    });
});
