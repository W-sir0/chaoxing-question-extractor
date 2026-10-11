const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = readFileSync(resolve(__dirname, '../chaoxing-question-extractor.user.js'), 'utf8');
function setup(html = '', url = 'https://mooc1.chaoxing.com/work/1') {
    const dom = new JSDOM(html, { url });
    const storage = new Map();
    const sandbox = {
        window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser,
        URL: dom.window.URL, Date, console, module: { exports: {} },
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
    };
    vm.runInNewContext(source, sandbox);
    return { api: sandbox.module.exports, dom, storage };
}

test('same-page cache is reusable and another page cannot reuse it', () => {
    const { api, dom } = setup();
    api.saveQuestions([{ title: '虚构题目', options: [] }]);
    assert.equal(api.getStoredQuestions()[0].title, '虚构题目');
    dom.reconfigure({ url: 'https://mooc1.chaoxing.com/work/2' });
    assert.equal(api.getStoredQuestions(), null);
});

test('cache identity includes query, SPA hash and OCR mode', () => {
    const { api } = setup();
    const first = api.cacheIdentity('https://a.chaoxing.com/work?id=1#first', false);
    for (const [url, ocr] of [
        ['https://a.chaoxing.com/work?id=2#first', false],
        ['https://a.chaoxing.com/work?id=1#second', false],
        ['https://a.chaoxing.com/work?id=1#first', true],
    ]) assert.notEqual(first, api.cacheIdentity(url, ocr));
});

test('expired, future, malformed and legacy cache records are ignored', () => {
    const { api, storage } = setup();
    api.saveQuestions([{ title: '虚构题目', options: [] }]);
    const key = 'cx_extracted_questions';
    const valid = storage.get(key);
    for (const value of [
        { ...valid, timestamp: Date.now() - 3600001 },
        { ...valid, timestamp: Date.now() + 10000 },
        { ...valid, questions: [null] },
        { ...valid, questions: [{ title: 'bad' }] },
        [{ title: '旧版缓存', options: [] }],
    ]) {
        storage.set(key, value);
        assert.equal(api.getStoredQuestions(), null);
    }
});

test('sanitizer removes executable attributes and active elements', () => {
    const { api, dom } = setup();
    const html = api.escapeHtml('<p onclick="evil()">题目<img src="javascript:evil()" onerror="evil()"><script>evil()</script><svg onload="evil()"></svg><iframe src="x"></iframe><a href="javascript:evil()">文字</a></p>', true);
    const fragment = dom.window.document.createElement('div');
    fragment.innerHTML = html;
    assert.equal(fragment.querySelector('script, svg, iframe, [onclick], [onerror], [href]'), null);
    assert.equal(fragment.querySelector('img'), null);
    assert.ok(fragment.textContent.includes('题目文字'));
});

test('sanitizer keeps MathML and resolves legitimate relative images', () => {
    const { api, dom } = setup();
    const html = api.escapeHtml('<math display="block"><mfrac><mi>x</mi><mn>2</mn></mfrac></math><img src="/math.png" alt="公式" style="position:fixed">', true);
    const fragment = dom.window.document.createElement('div');
    fragment.innerHTML = html;
    assert.equal(fragment.querySelector('mi').textContent, 'x');
    assert.equal(fragment.querySelector('img').getAttribute('src'), 'https://mooc1.chaoxing.com/math.png');
    assert.equal(fragment.querySelector('img').hasAttribute('style'), false);
});

test('plain text cannot become HTML', () => {
    const { api } = setup();
    assert.equal(api.escapeHtml('<script>1</script>'), '&lt;script&gt;1&lt;/script&gt;');
});

test('unrecognized page returns no questions rather than exporting the entire page', async () => {
    const { api } = setup('<p>这是一段虚构的普通页面文本，包含姓名、导航及其他与题目无关的信息。</p>');
    assert.equal((await api.extractQuestions()).length, 0);
});

test('nested question containers are extracted once and hidden questions are ignored', async () => {
    const { api } = setup('<div class="question"><div class="question">1. 虚构题目</div></div><div class="question" hidden>2. 隐藏内容</div>');
    assert.equal((await api.extractQuestions()).length, 1);
});

test('only visible answers are extracted', async () => {
    const { api, dom } = setup('<div class="TiMu">1. 虚构单选题<div class="answer" style="display:none">隐藏答案</div><div class="right-answer">A</div><div class="right-menu">导航</div></div>');
    const row = await api.extractQuestionData(dom.window.document.querySelector('.TiMu'), 1);
    assert.equal(row.answer, 'A');
    assert.equal(row.type, 'single');
    assert.equal(row.content.includes('隐藏答案'), false);
    assert.equal(row.titleHtml.includes('隐藏答案'), false);
});

test('hidden first-choice selectors do not prevent visible questions from matching', async () => {
    const { api } = setup('<div class="TiMu" hidden>隐藏内容</div><div class="question">1. 虚构题目</div>');
    assert.equal((await api.extractQuestions()).length, 1);
});

test('export button re-extracts the current page after navigation', async () => {
    const dom = new JSDOM('<div class="TiMu">1. 第一页虚构题目</div>', {
        url: 'https://mooc1.chaoxing.com/work/1', runScripts: 'outside-only',
    });
    await new Promise(resolve => dom.window.addEventListener('load', resolve));
    const w = dom.window;
    const storage = new Map();
    let exported = '';
    w.GM_getValue = (key, fallback) => storage.get(key) ?? fallback;
    w.GM_setValue = (key, value) => storage.set(key, value);
    w.setTimeout = () => 0;
    w.URL.createObjectURL = () => 'blob:fictional';
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = () => {};
    const Container = class { constructor(value) { this.value = value; } };
    w.docx = {
        Document: class { constructor(value) { exported = JSON.stringify(value); } },
        Paragraph: Container, TextRun: Container, HeadingLevel: {}, AlignmentType: {},
        Packer: { toBlob: async () => new w.Blob(['fictional']) },
    };
    w.eval(source);
    const buttons = Array.from(w.document.querySelectorAll('button'));
    await buttons.find(button => button.textContent.includes('提取题目')).onclick();
    dom.reconfigure({ url: 'https://mooc1.chaoxing.com/work/2' });
    w.document.querySelector('.TiMu').textContent = '1. 第二页虚构题目';
    await buttons.find(button => button.textContent.includes('导出Word')).onclick();
    assert.ok(exported.includes('第二页虚构题目'));
    assert.equal(exported.includes('第一页虚构题目'), false);
    dom.window.close();
});

test('control characters are cleaned without removing Chinese or line breaks', () => {
    const { api } = setup();
    assert.equal(api.cleanText('\uFEFF 题目\r\n甲\u200B '), '题目\n甲');
});
