const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const source = scripts.find(script => script.includes('function inventoryMissingFields()'));
const defaultDescription = 'ไม่พบรหัสนี้ในระบบ — กรุณากรอกข้อมูลเอง';

function setup() {
    const elements = new Map();
    for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
        const classes = new Set(id === 'ItemTypeSelect' ? ['hidden'] : []);
        const listeners = {};
        elements.set(id, {
            id, value: '', readOnly: true, placeholder: '', style: {}, options: [],
            classList: {
                contains: name => classes.has(name),
                add: name => classes.add(name),
                remove: name => classes.delete(name)
            },
            add(option) { this.options.push(option); },
            addEventListener(name, callback) { listeners[name] = callback; },
            dispatch(name, target) { listeners[name]?.({ target }); }
        });
    }
    const calls = [];
    const alerts = [];
    let lookup = async () => ({ found: false });
    const context = vm.createContext({
        document: {
            getElementById: id => elements.get(id),
            querySelector: () => ({ value: 'ไม่มีในระบบ' }),
            addEventListener() {}
        },
        window: { scrollTo() {} },
        localStorage: { getItem() { return null; } },
        Option: function(text, value) { this.text = text; this.value = value; },
        setTimeout() { return 0; }, clearTimeout() {},
        console,
        Swal: { fire: options => alerts.push(options) },
        mockGas: async (action, params) => {
            calls.push({ action, params });
            if (action === 'getItemDetails') return lookup(params.itemCode);
            return { success: true, itemCode: 'ไม่ทราบรหัสสินค้า 190' };
        }
    });
    // Execute the actual application script with network calls replaced.
    vm.runInContext(source, context);
    vm.runInContext(`
        gasCall = mockGas;
        resetForm = () => {};
        loadRealData = () => {};
        logTransaction = () => {};
        notifyDiscord = () => {};
        currentPhotoBase64 = 'data:image/jpeg;base64,dGVzdA==';
    `, context);
    for (const [id, value] of Object.entries({
        Location: 'B-IVE-013-C', OH: '1', InventoryStatus: 'Good', OnOffStatus: 'ON',
        LicensePlate: 'C000000100706', Remark: 'สินค้าปกติ', Name: 'Admin'
    })) elements.get(id).value = value;
    return {
        context, calls, alerts,
        element: id => elements.get(id),
        run: code => vm.runInContext(code, context),
        lookup: callback => { lookup = callback; },
        chooseType() {
            elements.get('ItemTypeSelect').value = 'SPARE PART';
            context.updateSubmitReadiness();
        }
    };
}

test('unknown button fills a real editable description immediately without a catalog lookup', () => {
    const app = setup();
    app.run(`inventoryData = [{Item: 'ไม่ทราบรหัสสินค้า 188'}]; fillUnknownItemCode();`);
    assert.equal(app.element('Item').value, 'ไม่ทราบรหัสสินค้า 189');
    assert.equal(app.element('ItemDesc').value, defaultDescription);
    assert.equal(app.element('ItemDesc').readOnly, false);
    assert.equal(app.element('ItemTypeSelect').classList.contains('hidden'), false);
    assert.equal(app.run('pendingAutoUnknownCode'), true);
    assert.equal(app.calls.length, 0);
    assert.equal(app.element('submitBtn').disabled, true); // Type is still required.
    app.chooseType();
    assert.equal(app.element('submitBtn').disabled, false);
    assert.equal(app.run('inventoryMissingFields().length'), 0);
});

test('saving the fallback description sends the backend numbering flag and chosen type', async () => {
    const app = setup();
    app.context.fillUnknownItemCode();
    app.chooseType();
    app.context.handleFormSubmit();
    await new Promise(resolve => setImmediate(resolve));
    const save = app.calls.find(call => call.action === 'recordInventory');
    assert.ok(save);
    assert.equal(save.params.data.Description, defaultDescription);
    assert.equal(save.params.data.Type, 'SPARE PART');
    assert.equal(save.params.data.AutoUnknownCode, true);
    assert.equal(app.alerts[0].icon, 'success');
    assert.match(app.alerts[0].text, /190/);
});

test('retry keeps the manually entered description, type, and automatic numbering flag', async () => {
    const app = setup();
    app.context.fillUnknownItemCode();
    app.element('ItemDesc').value = 'ชุดสายไฟ';
    app.chooseType();
    await app.context.checkItemInfo(app.element('Item').value, true);
    assert.equal(app.element('ItemDesc').value, 'ชุดสายไฟ');
    assert.equal(app.element('ItemTypeSelect').value, 'SPARE PART');
    assert.equal(app.run('pendingAutoUnknownCode'), true);
    assert.equal(app.element('submitBtn').disabled, false);
});

test('a missing catalog code gets the fallback and accepts a manual description', async () => {
    const app = setup();
    app.element('Item').value = 'MISSING-123';
    await app.context.checkItemInfo('MISSING-123');
    assert.equal(app.element('ItemDesc').value, defaultDescription);
    app.chooseType();
    assert.equal(app.element('submitBtn').disabled, false);
    app.element('ItemDesc').value = 'สายไฟ';
    await app.context.checkItemInfo('MISSING-123');
    assert.equal(app.element('ItemDesc').value, 'สายไฟ');
    assert.equal(app.element('ItemTypeSelect').value, 'SPARE PART');
    assert.equal(app.run('pendingAutoUnknownCode'), false);
});

test('editing a saved unknown item preserves its description and does not request a new number', async () => {
    const app = setup();
    app.run(`currentItemForEdit = {
        Item: 'ไม่ทราบรหัสสินค้า 189', Description: 'ชุดสายไฟ', Type: 'CUSTOM TYPE',
        LicensePlate: 'C000000100706', Location: 'B-IVE-013-C', Timestamp: 'original'
    };`);
    app.element('Item').value = 'ไม่ทราบรหัสสินค้า 189';
    await app.context.checkItemInfo(app.element('Item').value);
    assert.equal(app.element('ItemDesc').value, 'ชุดสายไฟ');
    assert.equal(app.element('ItemTypeSelect').value, 'CUSTOM TYPE');
    app.context.handleFormSubmit();
    await new Promise(resolve => setImmediate(resolve));
    const save = app.calls.find(call => call.action === 'updateInventoryItem');
    assert.ok(save);
    assert.equal(save.params.data.AutoUnknownCode, false);
    assert.equal(save.params.data.original.Item, 'ไม่ทราบรหัสสินค้า 189');
});

test('known catalog codes still use the returned description and type', async () => {
    const app = setup();
    app.lookup(async () => ({ found: true, description: 'Catalog item', type: 'CONSUMABLES' }));
    app.element('Item').value = 'KNOWN';
    await app.context.checkItemInfo('KNOWN');
    assert.equal(app.element('ItemDesc').value, 'Catalog item');
    assert.equal(app.element('ItemDesc').readOnly, true);
    assert.equal(app.element('ItemType').value, 'CONSUMABLES');
    assert.equal(app.element('submitBtn').disabled, false);
});

test('a late catalog response cannot replace a newly selected unknown item', async () => {
    const app = setup();
    let completeLookup;
    app.lookup(() => new Promise(resolve => { completeLookup = resolve; }));
    app.element('Item').value = 'OLD-CODE';
    const pending = app.context.checkItemInfo('OLD-CODE');
    app.context.fillUnknownItemCode();
    app.chooseType();
    completeLookup({ found: true, description: 'Old result', type: 'CONSUMABLES' });
    await pending;
    assert.equal(app.element('ItemDesc').value, defaultDescription);
    assert.equal(app.element('ItemTypeSelect').value, 'SPARE PART');
    assert.equal(app.run('pendingAutoUnknownCode'), true);
    assert.equal(app.element('submitBtn').disabled, false);
});

test('empty descriptions and other incomplete required fields still block saving', () => {
    const app = setup();
    app.context.fillUnknownItemCode();
    app.chooseType();
    app.element('ItemDesc').value = '  ';
    app.context.updateSubmitReadiness();
    assert.equal(app.element('submitBtn').disabled, true);
    assert.ok(app.run('inventoryMissingFields().includes("Description")'));
    app.element('ItemDesc').value = defaultDescription;
    app.element('OH').value = '0';
    app.run(`currentPhotoBase64 = '';`);
    app.context.handleFormSubmit();
    assert.equal(app.calls.length, 0);
    assert.equal(app.alerts[0].icon, 'warning');
    assert.match(app.element('formReadinessHint').textContent, /รูปถ่ายสินค้า/);
});

test('lookup errors continue to block saving for ordinary codes', async () => {
    const app = setup();
    app.lookup(async () => { throw new Error('offline'); });
    app.element('Item').value = 'ORDINARY-CODE';
    await app.context.checkItemInfo('ORDINARY-CODE');
    assert.equal(app.element('submitBtn').disabled, true);
    assert.equal(app.element('itemInfoError').textContent, 'offline');
});

test('typing a different code clears the unknown description and automatic numbering flag', () => {
    const app = setup();
    app.context.initializeInventoryValidation();
    app.context.fillUnknownItemCode();
    app.chooseType();
    app.element('Item').value = 'NEW-CODE';
    app.element('stockForm').dispatch('input', app.element('Item'));
    assert.equal(app.element('ItemDesc').value, '');
    assert.equal(app.run('pendingAutoUnknownCode'), false);
    assert.equal(app.element('submitBtn').disabled, true);
});
