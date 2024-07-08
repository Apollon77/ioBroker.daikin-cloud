'use strict';

/*
 * Created with @iobroker/create-adapter v1.32.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const Tools = require('@apollon/iobroker-tools');
const { DaikinCloudController, RateLimitedError} = require('daikin-controller-cloud');
const DataMapper = require('./lib/mapper');

/**
 * Utility function to create a Promise that can be resolved/rejected deferred
 *
 * @returns {Promise<any>}
 */
function getDeferredPromise() {
    let res;
    let rej;

    const resultPromise = new Promise((resolve, reject) => {
        res = resolve;
        rej = reject;
    });

    // @ts-ignore
    resultPromise.resolve = res;
    // @ts-ignore
    resultPromise.reject = rej;

    return resultPromise;
}

class DaikinCloudAdapter extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'daikin-cloud',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.daikinCloud = null;
        this.proxyRunning = false;
        this.proxyStopTimeout = null;
        this.knownDevices = {};
        this.deviceInfoSent = {};

        this.daikinOptions = null;

        this.pollTimeout = null;
        this.pollingInterval = 900;
        this.errorCount = 0;

        this.unloaded = false;
        this.authenticationPromise = null;
        this.expectedAuthenticationState = null;

        this.initDelayTimeout = null;
        this.doNotCommunicateBefore = Date.now();
    }

    async initDaikinCloud() {
        /**
         * Options to initialize the DaikinCloud instance with
         */
        this.daikinOptions = {
            tokenSet: this.tokenSet,
            oidcClientId: this.config.clientId,
            oidcClientSecret: this.config.clientSecret,
        };

        // Initialize Daikin Cloud Instance
        this.daikinCloud = new DaikinCloudController(this.daikinOptions);

        // Event that will be triggered on new or updated tokens, save into file
        this.daikinCloud.on('token_update', async tokenSet => {
            this.log.info('Daikin-Cloud tokens updated ...');
            this.tokenSet = tokenSet;
            await this.updateTokenSetForAdapter(tokenSet)
        });

        this.daikinCloud.on('rate_limit_status', async rateLimitStatus => {
            this.log.debug(`Rate Limit Status: ${JSON.stringify(rateLimitStatus)}`);
            const limitMinute = typeof(rateLimitStatus.limitMinute) === "number" ? rateLimitStatus.limitMinute : null;
            const limitDay = typeof(rateLimitStatus.limitDay) === "number" ? rateLimitStatus.limitDay : null;
            const remainingMinute = typeof(rateLimitStatus.remainingMinute) === "number" ? rateLimitStatus.remainingMinute : null;
            const remainingDay = typeof(rateLimitStatus.remainingDay) === "number" ? rateLimitStatus.remainingDay : null;
            await this.setState('info.rateLimitMinute', {val: limitMinute, ack: true});
            await this.setState('info.rateLimitDay', {val: limitDay, ack: true});
            await this.setState('info.rateRemainingMinute', {val: remainingMinute, ack: true});
            await this.setState('info.rateRemainingDay', {val: remainingDay, ack: true});
        });
    }

    normalizeDataStructure(data) {
        // normalize the special format of "electrical data" to look like all others.
        // We need to check for the main property "consumptionData" and then check for the sub property "electrical".
        // Electrical data have a "unit" field with value "kWh" on the main level with property "/electrical" but below
        // it data fields for "cooling" and "heating" (and probably others) with sub properties "d", "w", "m" and "y" with values as array
        // we need to move the "unit" field to the sub properties and remove the "unit" field on the main level.

        for (const dataKeys of Object.keys(data)) {
            this.log.debug(`Normalize data for ${dataKeys} - /electrical found? ${data[dataKeys] && data[dataKeys].consumptionData && data[dataKeys].consumptionData['/electrical'] ? 'yes' : 'no'}`);
            if (data[dataKeys] && data[dataKeys].consumptionData && data[dataKeys].consumptionData['/electrical']) {
                const electrical = data[dataKeys].consumptionData['/electrical'];
                if (typeof electrical.unit === "string") {
                    const unit = electrical.unit;
                    delete electrical.unit;
                    Object.keys(electrical).forEach(key => {
                        if (electrical[key] && typeof electrical[key] === 'object') {
                            Object.keys(electrical[key]).forEach(subKey => {
                                if (Array.isArray(electrical[key][subKey])) {
                                    const value = electrical[key][subKey];
                                    electrical[key][`${subKey}-raw`] = {unit, value};
                                    delete electrical[key][subKey];
                                } else {
                                    this.log.debug(`Ignore electrical data for ${key}/${subKey} because not an array.`);
                                }
                            });
                        }
                    });
                    this.log.debug(`Normalize data for ${dataKeys} - electrical found and normalized: ${JSON.stringify(electrical)}`);
                    data[dataKeys].consumptionData['/electrical'] = electrical;
                }
            }
        }
        return data;
    }

    async cleanupObsoleteObjects() {
        const delIds = Object.keys(this.objectHelper.existingStates).filter(id => id.includes(".") && !id.startsWith('info.'));
        if (delIds.length) {
            this.log.info(`Deleting the following obsolete states: ${JSON.stringify(delIds)}`);
            for (let i = 0; i < delIds.length; i++) {
                try {
                    await this.delObject(delIds[i]);
                } catch (err) {
                    this.log.info(`Can not delete object ${delIds[i]} ${err}`);
                }
                delete this.objectHelper.existingStates[delIds[i]];
            }
        }
    }

    async initDaikinDevice(deviceId, dev) {
        if (this.dataMapper === undefined) {
            this.log.error(`DataMapper not initialized!`);
            return;
        }
        this.knownDevices[deviceId] = this.knownDevices[deviceId] || {};
        this.knownDevices[deviceId].device = dev;
        this.knownDevices[deviceId].cloudConnected = dev.isCloudConnectionUp();
        this.log.info(`Initialize device ${deviceId}: connected ${dev.isCloudConnectionUp()}, lastUpdated ${dev.getLastUpdated()}`);

        let deviceNameObj = dev.getData('climateControl', 'name');
        let deviceName = deviceId;
        if (!deviceNameObj) { // Fallback for Altherma devices
            deviceNameObj = dev.getData('climateControlMainZone', 'name');
        }
        if (!deviceNameObj) { // Fallback for other Daikin devices
            const allData = dev.getData();
            for (let key of Object.keys(allData)) {
                if (
                    allData[key].name &&
                    allData[key].name.value !== 'Gateway' &&
                    typeof allData[key].name.value === 'string' &&
                    allData[key].name.value.length > 0
                ) {
                    deviceNameObj = allData[key].name;
                    break;
                }
            }
        }
        if (deviceNameObj) {
            deviceName = deviceNameObj.value;
        } else {
            if (!this.deviceInfoSent[deviceId]) {
                const devDataStr = JSON.stringify(dev.getData());
                this.log.debug(`No name found for device ${deviceId}: ${devDataStr}`);
                this.deviceInfoSent[deviceId] = true;
                this.Sentry && this.Sentry.withScope(scope => {
                    scope.setLevel('info');
                    scope.setExtra('deviceData', devDataStr);
                    this.Sentry.captureMessage(`Unknown Device Name ${deviceId}`, 'info');
                });
            }
        }
        this.objectHelper.setOrUpdateObject(deviceId, {
            type: 'device',
            common: {
                name: deviceName,
                statusStates: {
                    onlineId: `${this.namespace}.${deviceId}.cloudConnected`
                }
            },
            native: {
                id: deviceId
            }
        }, ['name']);

        this.objectHelper.setOrUpdateObject(`${deviceId}.cloudConnected`, {
            common: {
                name: 'connected',
                type: 'boolean',
                role: 'indicator.reachable',
                read: true,
                write: false
            }
        }, undefined, this.knownDevices[deviceId].cloudConnected);

        this.knownDevices[deviceId].lastUpdated = dev.getLastUpdated().getTime();
        this.objectHelper.setOrUpdateObject(`${deviceId}.lastUpdateReceived`, {
            common: {
                name: 'lastUpdateReceived',
                type: 'number',
                role: 'date',
                read: true,
                write: false
            }
        }, undefined, this.knownDevices[deviceId].lastUpdated);

        dev.on('updated', async () => {
            if (this.unloaded) return;
            const newLastUpdated = dev.getLastUpdated().getTime();
            const newCloudConnected = dev.isCloudConnectionUp();
            if (newCloudConnected !== this.knownDevices[deviceId].cloudConnected) {
                await this.setState(`${deviceId}.cloudConnected`, {val: dev.isCloudConnectionUp(), ack: true});
                this.log.info(`${deviceId}: Cloud connection status changed to ${dev.isCloudConnectionUp()} - Reinitialize all Objects`);
                await this.initDaikinDevice(dev.getId(), dev);
                await this.createOrUpdateAllObjects();
            }
            if (newLastUpdated !== this.knownDevices[deviceId].lastUpdated) {
                const normalizedDeviceData = this.normalizeDataStructure(dev.getData());
                const updatedStateIds = this.dataMapper.updateValues(normalizedDeviceData, deviceId);
                if (updatedStateIds) {
                    for (const stateId of updatedStateIds) {
                        const val = this.dataMapper.values.get(stateId);
                        this.log.debug(`update state: ${stateId} = ${val}`);
                        if (val !== undefined) {
                            await this.setState(stateId, val, true);
                        }
                    }
                }
                await this.setState(`${deviceId}.lastUpdateReceived`, {val: dev.getLastUpdated().getTime(), ack: true});
            }
        });

        const deviceData = dev.getData();
        this.log.debug(`${deviceId} Device data: ${JSON.stringify(deviceData)}`);
        const normalizedDeviceData = this.normalizeDataStructure(deviceData);
        this.log.debug(`${deviceId} Normalized device data: ${JSON.stringify(normalizedDeviceData)}`);
        const objIds = this.dataMapper.getObjectsForStructure(normalizedDeviceData, deviceId);
        if (objIds) {
            for (const objId of objIds) {
                const obj = this.dataMapper.objects.get(objId);
                const existingObj = this.objectHelper.getObject(objId);
                if (existingObj && existingObj.common && existingObj.common.write !== undefined) {
                    obj.common.write = existingObj.common.write || obj.common.write; // once true we leave it true
                }
                let onChange;
                if (obj && obj.type === 'state' && obj.common) {
                    if (obj.common.write) {
                        onChange = async (value) => {
                            if (this.unloaded) return;
                            if (this.doNotCommunicateBefore > Date.now()) {
                                this.log.info(`Ignore state change for ${objId} because communication blocked!`);
                                return;
                            }
                            const writeValue = this.dataMapper.convertValueWrite(objId, value, obj);
                            this.log.info(`Send state change for ${objId} with value=${writeValue} to ${obj.native.managementPoint} : ${obj.native.dataPoint} : ${obj.native.dataPointPath}`)
                            try {
                                await dev.setData(obj.native.managementPoint, obj.native.dataPoint, obj.native.dataPointPath, writeValue);
                                await this.setState(objId, {val: value, ack: true});
                            } catch (err) {
                                this.log.warn(`Error on State update for ${objId} with value=${writeValue}: ${err.message}`);
                            }
                            await this.pollDevices(60000);
                        };
                    } else {
                        onChange = async () => {
                            this.log.info(`Ignore state change for ${objId} because not writable!`);
                            const lastValue = this.dataMapper.values.get(objId);
                            if (lastValue !== undefined) {
                                await this.setState(objId, {val: lastValue, ack: true});
                            }
                        };
                    }
                }
                const val = obj && obj.type === 'state' ? this.dataMapper.values.get(objId) : undefined;
                this.objectHelper.setOrUpdateObject(objId, obj, ['name'], val, onChange);
                this.log.debug(`Added object ${objId} (${obj && obj.type})${obj && obj.type === 'state' ? ` with initial value = ${val}` : ''}`);
            }
        }
    }

    async initDaikinDevices() {
        const devices = await this.daikinCloud.getCloudDevices();
        if (!devices && !devices.length) {
            this.log.info('No Devices found in the Daikin Cloud account')
        }
        this.log.info(`Initialize ${devices.length} Daikin devices`);
        for (let dev of devices) {
            await this.initDaikinDevice(dev.getId(), dev);
        }
    }

    async pollDevices(delay) {
        this.pollTimeout && clearTimeout(this.pollTimeout);
        if (!delay) {
            delay = this.pollingInterval * 1000;
            if (this.doNotCommunicateBefore <= Date.now()) {
                try {
                    await this.daikinCloud.updateAllDeviceData();
                } catch (err) {
                    if (err instanceof RateLimitedError) {
                        this.log.warn(`Rate Limit reached, you did too many requests to the Daikin Cloud API! All requests blocked for ${err.retryAfter} seconds!`);
                        if (err.retryAfter != null) {
                            const retryAfter = parseInt(err.retryAfter);
                            if (!isNaN(retryAfter) && retryAfter > 0) {
                                this.doNotCommunicateBefore = Date.now() + retryAfter * 1000;
                            }
                        }
                    } else {
                        this.errorCount++;
                        const errorDetails = err.response && err.response.body && err.response.body.message;
                        this.log.warn(`Error on update (${this.errorCount}): ${err.message}${errorDetails ? ` (${errorDetails})` : ''}`);
                    }
                }
            } else {
                this.log.info(`Communication blocked till ${new Date(this.doNotCommunicateBefore).toISOString()}`);
            }
        }
        this.pollTimeout = setTimeout(async () => {
            await this.pollDevices();
        }, delay);
    }

    async createOrUpdateAllObjects() {
        return new Promise(resolve => {
            this.objectHelper.processObjectQueue(() => {
                resolve(true);
            });
        });
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        this.unloaded = false;
        this.objectHelper = Tools.objectHelper;
        this.objectHelper.init(this);

        this.dataMapper = new DataMapper();

        const tokenObject = await this.getObjectAsync('_config');
        this.tokenSet = tokenObject && tokenObject.native && tokenObject.native.tokenSet ? tokenObject.native.tokenSet : null;

        if (!this.Sentry && this.supportsFeature && this.supportsFeature('PLUGINS')) {
            const sentryInstance = this.getPluginInstance('sentry');
            if (sentryInstance) {
                this.Sentry = sentryInstance.getSentryObject();
            }
        }

        this.config.pollingInterval = parseInt(this.config.pollingInterval, 10) || 900;
        this.config.slowPollingInterval = parseInt(this.config.slowPollingInterval, 10) || 1800;
        if (isNaN(this.config.pollingInterval) || this.config.pollingInterval < 300) {
            this.log.warn(`Polling interval invalid or too low, set to 300 seconds (5 minutes)`);
            this.config.pollingInterval = 300;
        } else if (this.config.pollingInterval < 500) {
            this.log.info(`Polling interval is set to ${this.config.pollingInterval} seconds, this could conflict with the rate limit of 200 calls per day! be aware!`);
        }
        if (isNaN(this.config.slowPollingInterval) || this.config.slowPollingInterval < 300) {
            this.log.warn(`Slow Polling interval invalid or too low, set to 600 seconds (10 minutes)`);
            this.config.slowPollingInterval = 600;
        } else if (this.config.slowPollingInterval < 500) {
            this.log.info(`Slow Polling interval is set to ${this.config.pollingInterval} seconds, this could conflict with the rate limit of 200 calls per day! be aware!`);
        }

        if (this.config.slowPollingInterval < this.config.pollingInterval) {
            this.log.warn(`Slow Polling interval is lower than the normal polling interval, this could lead to problems with the rate limit of 200 calls per day! be aware! Adjusting to polling interval`);
            this.config.slowPollingInterval = this.config.pollingInterval;
        }

        // Reset the connection indicator during startup
        await this.setState('info.connection', false, true);

        if (!this.tokenSet || !this.tokenSet.refresh_token || !this.tokenSet.access_token) {
            this.log.warn('No tokens existing, please enter client id and secret of your Daikin Developer Account in Adapter settings and Authenticate via Admin Interface!');
            return;
        }

        const useSlowPolling = await this.getStateAsync(`${this.namespace}.useSlowPolling`);
        this.pollingInterval = useSlowPolling && useSlowPolling.val ? this.config.slowPollingInterval : this.config.pollingInterval;

        await this.initDaikinCloud();

        await new Promise(resolve => this.objectHelper.loadExistingObjects( () => resolve(true)));

        try {
            await this.initDaikinDevices();
        } catch (err) {
            if (this.unloaded) return;
            const errorDetails = err.response && err.response.body && err.response.body.message;
            this.log.warn(`Error on Daikin Cloud communication on adapter initialization: ${err.message}${errorDetails ? ` (${errorDetails})` : ''}`);
            let retryAfter = err instanceof RateLimitedError ? err.retryAfter : undefined;
            if (retryAfter !== undefined) {
                retryAfter = parseInt(retryAfter);
                if (isNaN(retryAfter) || retryAfter < 0) {
                    retryAfter = undefined;
                }
            }
            const initRetryDelay = retryAfter !== undefined ? Math.min(retryAfter, 60) : 60;
            this.log.info(`Retry initialization in ${initRetryDelay} seconds ...`);
            this.initDelayTimeout = setTimeout(async () => {
                await this.onUnload(() => {
                    this.onReady();
                });
            }, initRetryDelay * 1000);
            return;
        }

        await this.createOrUpdateAllObjects();

        for (const [stateId, val] of this.dataMapper.values.entries()) {
            if (val !== undefined) {
                this.log.debug(`Set initial state value: ${stateId} = ${val}`);
                await this.setState(stateId, val, true);
            }
        }

        await this.cleanupObsoleteObjects();

        await this.setState('info.connection', true, true);

        this.subscribeStates('*');

        await this.pollDevices(this.pollingInterval * 1000);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    async onUnload(callback) {
        this.unloaded = true;
        try {
            this.pollTimeout && clearTimeout(this.pollTimeout);
            this.initDelayTimeout && clearTimeout(this.initDelayTimeout);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
            if (id === `${this.namespace}.useSlowPolling` && !state.ack) {
                if (state.val) {
                    this.log.info(`Switch to slow polling interval`);
                    this.pollingInterval = this.config.slowPollingInterval;
                } else {
                    this.log.info(`Switch to normal polling interval`);
                    this.pollingInterval = this.config.pollingInterval;
                }
                await this.setState(id, state.val, true);
                return;
            }
            this.objectHelper.handleStateChange(id, state);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    async updateTokenSetForAdapter(tokenSet) {
        this.log.info('Daikin token updated in adapter configuration ...');
        await this.extendObject(`_config`, {
            native: {
                tokenSet
            }
        });
    }

    getDeviceInfo(msg) {
        let numDevices = Object.keys(this.knownDevices).length;
        let numConnectedToCloud = 0;
        for (let deviceId in this.knownDevices) {
            if (this.knownDevices[deviceId].cloudConnected) {
                numConnectedToCloud++;
            }
        }

        this.sendTo(msg.from, msg.command, {
            result: {
                devices: numDevices,
                numConnectedToCloud,
                tokenSetExisting: this.tokenSet && this.tokenSet.refresh_token && this.tokenSet.access_token
            },
            error: null
        }, msg.callback);
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.messagebox" property to be set to true in io-package.json
     * @param {ioBroker.Message} msg
     */
    async onMessage(msg) {
        if (typeof msg === 'object' && msg.message) {
            this.log.debug(`Message received: ${JSON.stringify(msg)}`);
            switch (msg.command) {
                case 'getRedirectBaseUrl':
                    const args = msg.message;
                    this.log.debug(`Received OAuth start message: ${JSON.stringify(args)}`);
                    if (!args || !args.clientId || !args.clientSecret || !args.redirectUriBase) {
                        this.sendTo(msg.from, msg.command, {
                            result: null,
                            error: 'Invalid arguments'
                        }, msg.callback);
                        return;
                    }
                    if (args.redirectUriBase.includes('127.0.0.1') || args.redirectUriBase.includes('localhost')) {
                        this.sendTo(msg.from, msg.command, {
                            result: null,
                            error: 'Please use a local IP or domain for the redirect URL. Localhost is not allowed.'
                        }, msg.callback);
                        return;
                    }
                    if (!args.redirectUriBase.endsWith('/')) args.redirectUriBase += '/';
                    args.redirectUriBase = `${args.redirectUriBase}oauth2_callbacks/${this.namespace}/`;
                    this.log.debug(`Get OAuth start link data: ${JSON.stringify(args)}`);
                    msg.callback && this.sendTo(msg.from, msg.command, {error: `Redirect URL: ${args.redirectUriBase} ... Enter in Daikin Developer App!`} , msg.callback);
                    break;
                case 'getOAuthStartLink': {
                    const args = msg.message;
                    this.log.debug(`Received OAuth start message: ${JSON.stringify(args)}`);
                    if (!args || !args.clientId || !args.clientSecret || !args.redirectUriBase) {
                        this.sendTo(msg.from, msg.command, {
                            result: null,
                            error: 'Invalid arguments'
                        }, msg.callback);
                        return;
                    }
                    if (!args.redirectUriBase.endsWith('/')) args.redirectUriBase += '/';
                    args.redirectUriBase = `${args.redirectUriBase}oauth2_callbacks/${this.namespace}/`;
                    this.log.debug(`Get OAuth start link data: ${JSON.stringify(args)}`);

                    await this.onUnload(async () => {
                        const daikinCloud = new DaikinCloudController({
                            oidcClientId: args.clientId,
                            oidcClientSecret: args.clientSecret,
                            oidcCallbackServerBaseUrl: args.redirectUriBase,

                            oidcAuthorizationTimeoutS: 600,
                            oidcCallbackServerBindAddr: '0.0.0.0', // remove
                            oidcCallbackServerPort: 1234, // remove
                            customOidcCodeReceiver: async (authUrl, reqState) => {
                                this.log.debug(`Get OAuth start link: ${authUrl} / reqState: ${reqState}`);
                                msg.callback && this.sendTo(msg.from, msg.command, {openUrl: authUrl}, msg.callback);
                                const authenticationPromise = getDeferredPromise();
                                this.authenticationPromise = authenticationPromise;
                                this.expectedAuthenticationState = reqState;
                                return authenticationPromise;
                            }
                        });

                        daikinCloud.on('token_update', async tokenSet => {
                            this.log.info('Daikin-Cloud tokens updated ...');
                            await this.updateTokenSetForAdapter(tokenSet);

                            this.log.info('Update data in adapter configuration ... restarting ...');
                            this.extendForeignObject(`system.adapter.${this.namespace}`, {
                                native: {
                                    clientId: this.encrypt(args.clientId),
                                    clientSecret: this.encrypt(args.clientSecret)
                                }
                            });
                        });

                        await daikinCloud.getApiInfo(); // trigger authentication
                    });
                    break;
                }
                case 'oauth2Callback': {
                    const args = msg.message;
                    this.log.debug(`OAuthRedirectReceived: ${JSON.stringify(args)}`);

                    if (!args.state || !args.code) {
                        this.log.warn(`Error on OAuth callback: ${JSON.stringify(args)}`);
                        if (args.error) {
                            msg.callback && this.sendTo(msg.from, msg.command, {error: `Daikin Cloud error: ${args.error}. Please try again.`}, msg.callback);
                        } else {
                            msg.callback && this.sendTo(msg.from, msg.command, {error: `Daikin Cloud invalid response: ${JSON.stringify(args)}. Please try again.`}, msg.callback);
                        }
                        return;
                    }

                    if (this.expectedAuthenticationState !== args.state) {
                        this.log.warn(`Error on OAuth callback: Invalid state received: ${args.state} (expected: ${this.expectedAuthenticationState})`);
                        msg.callback && this.sendTo(msg.from, msg.command, {error: `Daikin Cloud invalid state received. Please try again.`}, msg.callback);
                        return;
                    }
                    if (!this.authenticationPromise) {
                        this.log.warn(`Error on OAuth callback: No authentication promise available!`);
                        msg.callback && this.sendTo(msg.from, msg.command, {error: `Daikin Cloud internal error. Please try again.`}, msg.callback);
                        return;
                    }
                    // @ts-ignore
                    this.authenticationPromise.resolve(args.code);


                    msg.callback && this.sendTo(msg.from, msg.command, {result: 'Tokens updated successfully.'}, msg.callback);
                    break;
                }
                case 'getDeviceInfo':
                    this.getDeviceInfo(msg);
                    break;
            }
        }
    }

}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new DaikinCloudAdapter(options);
} else {
    // otherwise start the instance directly
    new DaikinCloudAdapter();
}
