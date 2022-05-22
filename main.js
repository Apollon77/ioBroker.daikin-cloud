'use strict';

/*
 * Created with @iobroker/create-adapter v1.32.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const Tools = require('@apollon/iobroker-tools');
const DaikinCloud = require('daikin-controller-cloud');
const os = require('os');
const path = require('path');
const fs = require('fs');
const DataMapper = require('./lib/mapper');

// Load your modules here, e.g.:
// const fs = require("fs");

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

        this.daikinOptions = null;
        this.proxyOptions = null;
    }

    async initDaikinCloud() {
        if (this.proxyRunning) {
            await this.daikinCloud.stopProxyServer();
            this.proxyOptions = null;
        }
        /**
         * Options to initialize the DaikinCloud instance with
         */
        this.daikinOptions = {
            logger: this.log.debug,
            logLevel: 'debug', // TODO??
        };

        // Initialize Daikin Cloud Instance
        this.daikinCloud = new DaikinCloud(this.tokenSet, this.daikinOptions);

        // Event that will be triggered on new or updated tokens, save into file
        this.daikinCloud.on('token_update', async tokenSet => {
            this.log.info('Updated tokens ...');
            this.tokenSet = tokenSet;
        });
    }

    async cleanupObsoleteObjects() {
        const delIds = Object.keys(this.objectHelper.existingStates);
        if (delIds.length) {
            this.log.info(`Deleting the following obsolete states: ${JSON.stringify(delIds)}`);
            for (let i = 0; i < delIds.length; i++) {
                try {
                    await this.delObject(delIds[i],);
                } catch (err) {
                    this.log.info(`Can not delete object ${delIds[i]} ${err}`);
                }
                delete this.objectHelper.existingStates[delIds[i]];
            }
        }
    }

    async initDaikinDevice(deviceId, dev) {
        this.log.info(`Initialize device ${deviceId}`);
        this.knownDevices[deviceId] = this.knownDevices[deviceId] || {};
        this.knownDevices[deviceId].device = dev;
        this.knownDevices[deviceId].pollTimeout && clearTimeout(this.knownDevices[deviceId].pollTimeout);
        this.knownDevices[deviceId].pollTimeout = null;

        this.objectHelper.setOrUpdateObject(deviceId, {
            type: 'device',
            common: {
                name: dev.getData('climateControl', 'name').value || deviceId,
                statusStates: {
                    onlineId: `${this.namespace}.${deviceId}.cloudConnected`
                }
            },
            native: {
                id: deviceId
            }
        }, ['name']);

        this.knownDevices[deviceId].cloudConnected = dev.isCloudConnectionUp();
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

        const objIds = this.dataMapper.getObjectsForStructure(dev.getData(), deviceId);
        if (objIds) {
            objIds.forEach(objId => {
                const obj = this.dataMapper.objects.get(objId);
                let onChange;
                if (obj && obj.type === 'state' && obj.common) {
                    if (obj.common.write) {
                        onChange = async (value) => {
                            const writeValue = this.dataMapper.convertValueWrite(objId, value, obj);
                            this.log.info(`Send state change for ${objId} with value=${writeValue} to ${obj.native.managementPoint} : ${obj.native.dataPoint} : ${obj.native.dataPointPath}`)
                            try {
                                await dev.setData(obj.native.managementPoint, obj.native.dataPoint, obj.native.dataPointPath, writeValue);
                                await this.setState(objId, {val: value, ack: true});
                            } catch (err) {
                                this.log.warn(`Error on State update for ${objId} with value=${writeValue}: ${err.message}`);
                            }
                            await this.pollDevice(deviceId, 10000);
                        };
                    } else {
                        onChange = async () => {
                            this.log.info(`Ignore state change for ${objId} because not writable!`);
                            const lastValue = this.dataMapper.values.get(objId);
                            if (lastValue !== undefined) {
                                this.setState(objId, {val: lastValue, ack: true});
                            }
                        };
                    }
                }
                const val = obj && obj.type === 'state' ? this.dataMapper.values.get(objId) :  undefined;
                this.objectHelper.setOrUpdateObject(objId, obj, ['name'], val, onChange);
                this.log.debug(`Added object ${objId} (${obj && obj.type})${obj && obj.type === 'state' ? ` with initial value = ${val}` : ''}`);
            });
        }
    }

    async initDaikinDevices() {
        const devices = await this.daikinCloud.getCloudDevices();

        if (!devices && !devices.length) {
            this.log.info('No Devices found in the Daikin Cloud account')
        }
        for (let dev of devices) {
            await this.initDaikinDevice(dev.getId(), dev);
        }
    }

    async pollDevice(deviceId, delay) {
        if (this.knownDevices[deviceId].pollTimeout) {
            clearTimeout(this.knownDevices[deviceId].pollTimeout);
            this.knownDevices[deviceId].pollTimeout = null;
        }
        if (!delay) {
            delay = this.config.pollingInterval * 1000;
            if (this.knownDevices[deviceId]) {
                const dev = this.knownDevices[deviceId].device;
                if (dev) {
                    try {
                        await dev.updateData();
                        const newLastUpdated = dev.getLastUpdated().getTime();
                        const newCloudConnected = dev.isCloudConnectionUp();
                        if (newCloudConnected !== this.knownDevices[deviceId].cloudConnected) {
                            this.setState(`${deviceId}.cloudConnected`, {val: dev.isCloudConnectionUp(), ack: true});
                            this.log.info(`${deviceId}: Cloud connection status changed to ${dev.isCloudConnectionUp()} - Reinitialize all Objects`);
                            await this.initDaikinDevice(dev.getId(), dev);
                            await this.createOrUpdateAllObjects();
                        }
                        if (newLastUpdated !== this.knownDevices[deviceId].lastUpdated) {
                            const updatedStateIds = this.dataMapper.updateValues(dev.getData(), deviceId);
                            if (updatedStateIds) {
                                updatedStateIds.forEach(stateId => {
                                    const val = this.dataMapper.values.get(stateId);
                                    this.log.debug(`update state: ${stateId} = ${val}`);
                                    if (val !== undefined) {
                                        this.setState(stateId, val, true);
                                    }
                                });
                            }
                            this.setState(`${deviceId}.lastUpdateReceived`, {val: dev.getLastUpdated().getTime(), ack: true});
                        }
                    } catch (err) {
                        this.log.warn(`${deviceId}: Error on device update: ${err.message}`);
                    }
                }
            }
        }
        this.knownDevices[deviceId].pollTimeout = setTimeout(async () => {
            await this.pollDevice(deviceId);
        }, delay);
    }

    async createOrUpdateAllObjects() {
        return new Promise(resolve => {
            this.objectHelper.processObjectQueue(() => {
                resolve(true);
            })
        });
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        this.objectHelper = Tools.objectHelper;
        this.objectHelper.init(this);

        this.dataMapper = new DataMapper();

        this.tokenSet = this.config.tokenSet;

        this.config.pollingInterval = parseInt(this.config.pollingInterval, 10) || 60;
        if (this.config.pollingInterval < 30) {
            this.log.info(`Polling interval too low, set to 30 seconds`);
            this.config.pollingInterval = 30;
        }

        // Reset the connection indicator during startup
        await this.setStateAsync('info.connection', false, true);

        await this.objectHelper.loadExistingObjects();

        if (!this.tokenSet || !this.tokenSet.refresh_token || !this.tokenSet.access_token) {
            this.log.warn('No token set, please Login the your Daikin Cloud account in the adapter settings');
            return;
        }

        await this.initDaikinCloud();

        try {
            await this.initDaikinDevices();
        } catch (err) {
            const errorDetails = err.response && err.response.body && err.response.body.message;
            this.log.warn(`Error on Daikin Cloud communication: ${err.message}${errorDetails ? ` (${errorDetails})` : ''}`);
            this.log.warn('Please Re-Login the your Daikin Cloud account in the adapter settings');
            return;
        }

        await this.createOrUpdateAllObjects();

        for (const [stateId, val] of this.dataMapper.values.entries()) {
            if (val !== undefined) {
                this.log.debug(`Set initial state value: ${stateId} = ${val}`);
                await this.setStateAsync(stateId, val, true);
            }
        }

        await this.cleanupObsoleteObjects();

        await this.setStateAsync('info.connection', true, true);

        this.subscribeStates('*');

        let cnt = 0;
        for (let deviceId in this.knownDevices) {
            await this.pollDevice(deviceId, (this.config.pollingInterval + cnt++ * 2) * 1000);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    async onUnload(callback) {
        try {
            this.proxyStopTimeout && clearTimeout(this.proxyStopTimeout);
            if (this.proxyRunning) {
                await this.daikinCloud.stopProxyServer();
                this.proxyOptions = null;
            }

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
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
            this.objectHelper.handleStateChange(id, state);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    async startProxy(msg) {
        if (!this.proxyRunning) {

            const ifaces = os.networkInterfaces();
            let ownIp;
            if (msg && msg.message && msg.message.proxyOwnIp) {
                ownIp = msg.message.proxyOwnIp;
            } else if (this.config.proxyOwnIp) {
                ownIp = this.config.proxyOwnIp;
            } else if (ifaces) {
                for (let eth of Object.keys(ifaces)) {
                    if (!ifaces[eth] || !Array.isArray(ifaces[eth])) continue;
                    for (let ethIFace of ifaces[eth]) {
                        if (ethIFace.family !== 'IPv6' && ethIFace.family !== 6 && ethIFace.address !== '127.0.0.1' && ethIFace.address !== '0.0.0.0') {
                            ownIp = ethIFace.address;
                            this.log.debug(`Use first network interface (${ownIp})`);
                            break;
                        }
                    }
                    if (ownIp) break;
                }
            }
            const configPath = utils.getAbsoluteInstanceDataDir(this);
            const certPath = path.join(configPath, 'certs/ca.pm');
            if (fs.existsSync(configPath)) {
                try {
                    const certStat = fs.statSync(certPath);
                    if (certStat && Date.now() - certStat.ctimeMs > 90 * 24 * 60 * 60 * 1000) { // > 90d
                        fs.unlinkSync(certPath);
                        this.log.info(`Proxy certificates recreated. You need to load new certificate!`);
                    }
                } catch (err) {
                    this.log.info(`Could not check/recreate proxy certificates: ${err.message}`);
                }
            } else {
                fs.mkdirSync(configPath);
            }

            this.config.proxyPort = parseInt(this.config.proxyPort, 10);
            if (isNaN(this.config.proxyPort) || this.config.proxyPort < 1024 || this.config.proxyPort > 65535) {
                this.log.warn('Invalid port set for Proxy. Reset to 8888');
                this.config.proxyPort = 8888;
            }
            this.config.proxyWebPort = parseInt(this.config.proxyWebPort, 10);
            if (isNaN(this.config.proxyWebPort) || this.config.proxyWebPort < 1024 || this.config.proxyWebPort > 65535) {
                this.log.warn('Invalid port set for Proxy web port. Reset to 8889');
                this.config.proxyWebPort = 8889;
            }

            let altProxyPort = parseInt(msg && msg.message && msg.message.proxyPort, 10);
            if (isNaN(altProxyPort) || altProxyPort < 1024 || altProxyPort > 65535) {
                this.log.warn(`Invalid port set for Proxy. Reset to ${this.config.proxyPort}`);
                altProxyPort = this.config.proxyPort;
            }
            let altProxyWebPort = parseInt(msg && msg.message && msg.message.proxyWebPort, 10);
            if (isNaN(altProxyWebPort) || altProxyWebPort < 1024 || altProxyWebPort > 65535) {
                this.log.warn(`Invalid port set for Proxy web port. Reset to ${this.config.proxyWebPort}`);
                altProxyWebPort = this.config.proxyWebPort;
            }

            this.proxyOptions = {
                proxyOwnIp: ownIp, // TODO
                proxyPort: altProxyPort,
                proxyWebPort: altProxyWebPort,
                proxyListenBind: '0.0.0.0',   // TODO??
                proxyDataDir: configPath
            };

            try {
                await this.daikinCloud.initProxyServer(this.proxyOptions);
                this.proxyRunning = true;
            } catch (err) {
                this.log.error(`Error while starting Proxy: ${err}`);
                this.sendTo(msg.from, msg.command, {
                    result: {},
                    error: err
                }, msg.callback);
                return;
            }
        }

        const dataUrl = `http://${this.proxyOptions.proxyOwnIp}:${this.proxyOptions.proxyWebPort}`;
        this.log.info(`SSL-Proxy ready to receive requests. Please visit ${dataUrl} and follow instructions there.`);

        let QRCode4Url;
        try {
            const QRCode = require('qrcode');
            QRCode4Url = await QRCode.toDataURL(dataUrl);
        } catch (err) {
            this.log.error(`Error while creating QR Code for Admin: ${err}`);
        }
        this.sendTo(msg.from, msg.command, {
            result: {
                url: dataUrl,
                qrcodeUrl: QRCode4Url ? QRCode4Url : 'Not existing'
            },
            error: null
        }, msg.callback);

        this.proxyStopTimeout && clearTimeout(this.proxyStopTimeout);
        this.proxyStopTimeout = setTimeout(async () => {
            this.proxyStopTimeout = null;
            if (this.daikinCloud) {
                await this.daikinCloud.stopProxyServer();
                this.log.info(`Proxy stopped. Restart adapter or start Proxy via Adapter configuration interface!`);
            }
            this.proxyRunning = false;
        }, 600 * 1000);

        try {
            // wait for user Login and getting the tokens
            const resultTokenSet = await this.daikinCloud.waitForTokenFromProxy();
            this.log.debug(`Token data: ${JSON.stringify(resultTokenSet)}`);

            // show some details about the tokens (could be outdated because first real request is done afterwards
            const claims = this.daikinCloud.getTokenSet().claims();
            this.log.debug(`Use Token with the following claims: ${JSON.stringify(claims)}`);
            this.log.info(`Successfully retrieved tokens for user ${claims.name} / ${claims.email}`);

            const devices = await this.daikinCloud.getCloudDevices();

            if (this.proxyAdminMessageCallback) {
                this.log.info(`${devices.length} devices found in Daikin account.`);
                this.sendTo(this.proxyAdminMessageCallback.from, this.proxyAdminMessageCallback.command, {
                    result: {
                        deviceCount: devices.length
                    },
                    error: null
                }, this.proxyAdminMessageCallback.callback);
                this.proxyAdminMessageCallback = null;
            }

            this.log.info('Daikin token updated in adapter configuration ... restarting adapter in 1s...');
            setTimeout(() => {
                this.extendForeignObject(`system.adapter.${this.namespace}`, {
                    native: {
                        tokenSet: resultTokenSet
                    }
                });
            }, 1000);
        } catch (err) {
            this.log.error(`Error while waiting for Proxy Result: ${err.message}`);
        }
    }

    async stopProxy(msg) {
        this.proxyStopTimeout && clearTimeout(this.proxyStopTimeout);

        if (this.daikinCloud) {
            await this.daikinCloud.stopProxyServer();
        }
        this.proxyRunning = false;

        if (msg) {
            this.sendTo(msg.from, msg.command, {
                result: true,
                error: null
            }, msg.callback);
        }
    }

    getProxyResult(msg) {
        this.proxyAdminMessageCallback = msg;
    }

    getDeviceInfo(msg) {
        let numDevices = Object.keys(this.knownDevices).length;
        let numConnectedToCloud = 0;
        for (let deviceId in this.knownDevices) {
            if (this.knownDevices[deviceId].connectedToCloud) {
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
    onMessage(msg) {
        if (typeof msg === 'object' && msg.message) {
            this.log.debug(`Message received: ${JSON.stringify(msg)}`);
            switch (msg.command) {
                case 'startProxy':
                    this.startProxy(msg);
                    break;
                case 'stopProxy':
                    this.stopProxy(msg);
                    break;
                case 'getProxyResult':
                    this.getProxyResult(msg);
                    break;
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
