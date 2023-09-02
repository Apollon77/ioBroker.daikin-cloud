class ObjectMapper {
    constructor() {
        this.objects = new Map();
        this.values = new Map();
    }

    defineRole(id, obj) {
        const currentId = id.split('.').pop();
        // Try to set roles
        let role = '';
        if (obj.type === 'boolean') {
            if (obj.read && !obj.write) { // Boolean, read-only --> Sensor OR Indicator!
                role = 'sensor';
                if (currentId.match(/^is[^a-z]/)) {
                    role = 'indicator';
                }
            }
            else if (obj.write && !obj.read) { // Boolean, write-only --> Button
                role = 'button';
            }
            else if (obj.read && obj.write) { // Boolean, read-write --> Switch
                role = 'switch';
            }
        }
        else if (obj.type === 'number') {
            if (obj.read && !obj.write) { // Number, read-only --> Value
                role = 'value';
            }
            else if (obj.write && !obj.read) { // Boolean, write-only --> ?? Level?
                role = 'level';
            }
            else if (obj.read && obj.write) { // Number, read-write --> Level
                role = 'level';
            }

            if (id.endsWith('Temperature')) {
                role += '.temperature';
            } else if (id.endsWith('Humidity')) { // Not seen, but maybe exists
                role += '.humidity';
            } else if (id.includes('.consumptionData.electrical.') && obj.unit === 'kWh') { // Not seen, but maybe exists
                role += '.power.consumption';
            }
        }
        else if (obj.type === 'string') {
            role = 'text';
        }
        return role;
    }

    parseDatapoint(stateName,  stateData) {
        const common = {};
        let value = stateData.value;
        if (value && typeof value === 'object') {
            if (value.hasOwnProperty('enabled')) {
                value = value.enabled;
            } else {
                value = JSON.stringify(value);
                common.type = Array.isArray(value) ? 'array' : 'object';
            }
        }
        common.type = common.type || value !== undefined ? typeof value : 'mixed';
        common.read = true;
        common.write = stateData.settable;
        if (stateData.maxValue !== undefined) {
            common.max = stateData.maxValue;
        }
        if (stateData.minValue !== undefined) {
            common.min = stateData.minValue;
        }
        if (stateData.stepValue !== undefined) {
            common.step = stateData.stepValue;
        }
        if (stateData.values !== undefined) {
            if (stateData.values.length === 2 && stateData.values.includes('on') && stateData.values.includes('off')) {
                common.type = 'boolean';
            } else {
                common.states = {};
                stateData.values.forEach((value, idx) => {
                    common.states[idx] = value;
                });
                common.type = 'number';
            }
        }
        if (stateData.unit !== undefined) {
            common.unit = stateData.unit;
        } else if (stateName.endsWith('Temperature') && typeof value === 'number') {
            common.unit = '°C';
        }
        return common;
    }

    getObjectsForStructure(data, idPrefix, parentName, thisName, nativeBase) {
        let addedObjects = [];
        // console.log(' start getObjectsForStructure: ', idPrefix, parentName, thisName, nativeBase);
        if (thisName === 'meta' || data.value !== undefined || data.settable !== undefined || data.unit !== undefined) { // We found the lowest level
            const originalThisName = thisName;
            if (thisName.startsWith('/')) {
                const subStateArray = thisName.split('/');
                thisName = subStateArray.pop();
                if (parentName) {
                    idPrefix += '.' + parentName;
                }
                parentName = subStateArray.pop();
                subStateArray.forEach(sub => {
                    idPrefix += sub ? ('.' + sub) : ('');
                    if (!this.objects.has(idPrefix)) {
                        addedObjects.push(idPrefix);
                        this.objects.set(idPrefix, {
                            type: 'folder',
                            common: {
                                name: sub
                            }
                        });
                        // console.log(`   PUSH FOLDER: ${idPrefix}`);
                    }
                });

            }

            if (parentName) {
                idPrefix += '.' + parentName;
                if (!this.objects.has(idPrefix)) {
                    addedObjects.push(idPrefix);
                    this.objects.set(idPrefix, { // So we push the channel object
                        type: 'channel',
                        common: {
                            name: parentName
                        }
                    });
                    // console.log(`   PUSH CHANNEL: ${idPrefix}`);
                }
            }
            const native = nativeBase ? Object.assign({}, nativeBase) : {};
            if (native.managementPoint === undefined) {
                native.managementPoint = thisName;
            } else if (native.dataPoint === undefined) {
                native.dataPoint = thisName;
            } else if (native.dataPointPath === undefined && originalThisName.startsWith('/')) {
                native.dataPointPath = originalThisName;
            }

            if (!this.objects.has(idPrefix + '.' + thisName)) {
                const common = this.parseDatapoint(thisName, data);
                common.name = thisName;
                common.role = this.defineRole(idPrefix + '.' + thisName, common);

                if (data.value && typeof data.value === 'object' && data.value.hasOwnProperty('enabled') && common.type === 'boolean') {
                    native.convertInfo = 'enabled-object';
                }

                const stateId = idPrefix + '.' + thisName;
                addedObjects.push(stateId);
                this.objects.set(stateId, {
                    type: 'state',
                    common,
                    native: {
                        ...native,
                        values: data.values
                    }
                });
                const value = this.convertValueRead(stateId, data.value);
                if (this.values.get(stateId) !== value) {
                    this.values.set(stateId, value);
                }
                // console.log(`   PUSH STATE: ${stateId} = ${value}`);
            }
        } else {
            if (parentName) {
                const parentStr = parentName.startsWith('/') ? parentName.substring(1).replace(/\//g, '.') : parentName;
                idPrefix += '.' + parentStr;
            }
            Object.keys(data).forEach(key => {
                const native = Object.assign({}, nativeBase);
                if (native.managementPoint === undefined) {
                    native.managementPoint = key;
                } else if (native.dataPoint === undefined) {
                    native.dataPoint = key;
                } else if (native.dataPointPath === undefined) {
                    native.dataPointPath = key;
                } else {
                    if (data[key] && data[key].settable) {
                        throw new Error('Unsupported structure');
                    }
                }

                if (data[key] !== null && typeof data[key] === 'object') {
                    addedObjects = addedObjects.concat(this.getObjectsForStructure(data[key], idPrefix, thisName, key, native));
                } else {
                    // console.log(`    IGNORE ${key}`);
                }
                if (!this.objects.has(idPrefix)) {
                    addedObjects.push(idPrefix);
                    this.objects.set(idPrefix, { // So we push the folder object
                        type: 'folder',
                        common: {
                            name: parentName
                        }
                    });
                    // console.log(`   PUSH CHANNEL: ${idPrefix}`);
                }
            });
        }
        return addedObjects;
    }

    convertValueRead(id, value, obj) {
        if (!obj) {
            obj = this.objects.get(id);
        }
        if (obj && obj.native && obj.native.values) {
            value = obj.native.values.indexOf(value);
            if (value === -1) {
                value = null;
            } else if (obj.common && obj.common.type === 'boolean' && obj.native.values.length === 2) {
                value = obj.native.values.indexOf('on') === value;
            }
        } else if (value === undefined) {
            value = null;
        } else if (value && typeof value === 'object' && value.hasOwnProperty('enabled') && obj && obj.native && obj.native.convertInfo === 'enabled-object') {
            value = value.enabled;
        } else if (value && typeof value === 'object') {
            value = JSON.stringify(value);
        }
        return value;
    }

    convertValueWrite(id, value, obj) {
        if (!obj) {
            obj = this.objects.get(id);
        }
        if (obj && obj.native && obj.native.values) {
            if (obj.common && obj.common.type === 'boolean' && obj.native.values.length === 2) {
                value = value ? 'on' : 'off';
            } else {
                value = obj.native.values[value];
            }
        } else if (obj && obj.native && obj.native.convertInfo === 'enabled-object') {
            value =  { enabled: !!value };
        } else if (value && typeof value === 'object') {
            value = JSON.parse(value);
        }
        return value;
    }

    updateValues(data, idPrefix, thisName) {
        let updatedData = [];
        // console.log(' start updateValues: ', idPrefix, thisName);

        if (thisName) {
            if (thisName.startsWith('/')) {
                idPrefix += thisName.replace(/\//g, '.');
            } else {
                idPrefix += '.' + thisName;
            }
        }

        if (thisName === 'meta' || data.value !== undefined || data.settable !== undefined || data.unit !== undefined) { // We found the lowest level
            const value = this.convertValueRead(idPrefix, data.value);
            if (this.values.get(idPrefix) !== value) {
                this.values.set(idPrefix, value);
                updatedData.push(idPrefix);
                // console.log(`   UPDATE VALUE: ${idPrefix} = ${value}`);
            }
        } else {
            Object.keys(data).forEach(key => {
                if (data[key] !== null && typeof data[key] === 'object') {
                    updatedData = updatedData.concat(this.updateValues(data[key], idPrefix, key));
                } else {
                    // console.log(`    IGNORE ${key}`);
                }
            });
        }
        return updatedData;
    }
}

module.exports = ObjectMapper;
