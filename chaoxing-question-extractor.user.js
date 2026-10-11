// ==UserScript==
// @name         学习通题目提取工具
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  提取学习通考试/作业题目，支持导出Word和PDF格式
// @author       W-sir0
// @match        https://*.chaoxing.com/*
// @match        http://*.chaoxing.com/*
// @match        https://mooc1-*.chaoxing.com/*
// @match        http://mooc1-*.chaoxing.com/*
// @homepageURL  https://github.com/W-sir0/chaoxing-question-extractor
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/docx/7.8.2/docx.min.js
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js
// ==/UserScript==

(function() {
    'use strict';

    // 存储键名
    const STORAGE_KEY = 'cx_extracted_questions';
    const OCR_ENABLED_KEY = 'cx_ocr_enabled';

    // OCR功能开关
    let ocrEnabled = false;

    // 只复用当前 URL、OCR 设置及一小时内的缓存；旧格式不再读取。
    function cacheIdentity(pageUrl = window.location.href, ocr = ocrEnabled) {
        const url = new URL(pageUrl);
        return JSON.stringify([url.origin, url.pathname, url.search, url.hash, Boolean(ocr)]);
    }

    function getStoredQuestions(identity = cacheIdentity()) {
        try {
            const cached = GM_getValue(STORAGE_KEY, null);
            const age = cached && Date.now() - cached.timestamp;
            if (cached && cached.version === 2 && cached.identity === identity &&
                Number.isFinite(age) && age >= 0 && age < 3600000 &&
                Array.isArray(cached.questions) && cached.questions.every(q =>
                    q && typeof q.title === 'string' && Array.isArray(q.options))) {
                return cached.questions;
            }
        } catch (error) {
            console.error('读取缓存失败:', error);
        }
        return null;
    }

    function saveQuestions(questions, identity = cacheIdentity()) {
        try {
            GM_setValue(STORAGE_KEY, { version: 2, identity, timestamp: Date.now(), questions });
        } catch (error) {
            console.error('保存缓存失败:', error);
        }
    }

    function isVisible(element) {
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
            if (node.hidden || node.getAttribute('aria-hidden') === 'true' ||
                node.style.display === 'none' || node.style.visibility === 'hidden') return false;
            if (typeof getComputedStyle === 'function') {
                const style = getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
            }
        }
        return true;
    }

    // 等待页面加载完成
    function waitForElement(selector, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const checkElement = () => {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error(`元素 ${selector} 未找到`));
                } else {
                    setTimeout(checkElement, 100);
                }
            };
            checkElement();
        });
    }

    // 提取题目信息
    async function extractQuestions() {
        const questions = [];
        
        // 尝试多种可能的题目容器选择器
        const questionSelectors = [
            '.TiMu',
            '.question',
            '.question-li',
            '[class*="question"]',
            '.topic',
            'li[class*="TiMu"]',
            '.testItem'
        ];

        let questionElements = [];
        
        for (const selector of questionSelectors) {
            const elements = Array.from(document.querySelectorAll(selector)).filter(el =>
                !el.closest('#cx-question-extractor-panel') && isVisible(el));
            if (elements.length > 0) {
                questionElements = Array.from(elements);
                break;
            }
        }

        // 排除嵌套重复、隐藏内容和工具自身；没有结构化题目时明确返回空结果。
        questionElements = questionElements.filter(el =>
            !el.closest('#cx-question-extractor-panel') && isVisible(el));
        questionElements = questionElements.filter(el =>
            !questionElements.some(other => other !== el && other.contains(el)));

        // 如果启用OCR，显示进度
        if (ocrEnabled && questionElements.length > 0) {
            showMessage('正在识别图片文字，请稍候...', 'info');
        }

        // 逐个提取题目（支持OCR）
        for (let index = 0; index < questionElements.length; index++) {
            try {
                const element = questionElements[index];
                const questionData = await extractQuestionData(element, index + 1);
                if (questionData) {
                    questions.push(questionData);
                }
            } catch (error) {
                console.error('提取题目时出错:', error);
            }
        }

        return questions;
    }

    // OCR识别图片文字
    async function recognizeImage(imageSrc) {
        try {
            if (typeof Tesseract === 'undefined') {
                console.warn('Tesseract.js未加载');
                return null;
            }

            // 使用Tesseract识别图片（支持中英文）
            const { data: { text } } = await Tesseract.recognize(
                imageSrc,
                'chi_sim+eng', // 简体中文+英文
                {
                    logger: m => {
                        // 可以在这里添加进度回调
                        if (m.status === 'recognizing text') {
                            // console.log(`OCR进度: ${Math.round(m.progress * 100)}%`);
                        }
                    }
                }
            );
            
            return text.trim();
        } catch (error) {
            console.error('OCR识别失败:', error);
            return null;
        }
    }

    // 提取图片并执行OCR（如果启用）
    async function extractImagesWithOCR(element) {
        if (!ocrEnabled) return {};
        
        const images = element.querySelectorAll('img');
        const imageOcrResults = {};
        
        // 限制并发数量，避免性能问题
        const maxConcurrent = 2; // 降低并发数，OCR比较耗时
        const imageArray = Array.from(images).filter(img => {
            // 过滤掉明显不是题目内容的图片
            const src = img.src || img.getAttribute('data-src') || '';
            const alt = (img.alt || '').toLowerCase();
            const className = (img.className || '').toLowerCase();
            
            // 跳过小图标、装饰性图片
            if (img.naturalWidth <= 50 || img.naturalHeight <= 50) return false;
            if (alt.includes('icon') || alt.includes('logo')) return false;
            if (className.includes('icon') || className.includes('logo')) return false;
            
            return true;
        });
        
        if (imageArray.length === 0) return {};
        
        for (let i = 0; i < imageArray.length; i += maxConcurrent) {
            const batch = imageArray.slice(i, i + maxConcurrent);
            await Promise.all(
                batch.map(async (img) => {
                    try {
                        let src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
                        if (!src || src.startsWith('data:')) return;
                        
                        // 转换为绝对URL
                        if (!src.startsWith('http')) {
                            src = new URL(src, window.location.href).href;
                        }
                        
                        if (!imageOcrResults[src]) {
                            const ocrText = await recognizeImage(src);
                            if (ocrText && ocrText.trim().length > 0) {
                                imageOcrResults[src] = ocrText.trim();
                            }
                        }
                    } catch (error) {
                        console.error('图片OCR处理失败:', error);
                    }
                })
            );
        }
        
        return imageOcrResults;
    }

    // 提取并保留数学公式的HTML
    function extractMathHtml(element) {
        if (!element) return '';
        
        // 克隆元素以便处理
        const clone = element.cloneNode(true);
        
        // 保留MathML标签
        const mathElements = clone.querySelectorAll('math, mrow, mi, mo, mn, mfrac, msqrt, msup, msub, munderover, mtable, mtr, mtd');
        mathElements.forEach(math => {
            // MathML已保留，无需处理
        });
        
        // 保留数学公式图片
        const mathImages = clone.querySelectorAll('img[src*="math"], img[alt*="公式"], img[class*="math"], img[class*="formula"]');
        mathImages.forEach(img => {
            // 转换为绝对URL
            if (img.src && !img.src.startsWith('http')) {
                img.src = new URL(img.src, window.location.href).href;
            }
        });
        
        // 提取LaTeX格式的公式（$...$ 或 $$...$$）
        let html = clone.innerHTML;
        
        return html;
    }

    // 提取单个题目的数据
    async function extractQuestionData(element, number) {
        // 连正文和公式 HTML 一并排除隐藏内容，不能只过滤 answer 字段。
        const visibleClone = element.cloneNode(true);
        const originalNodes = Array.from(element.querySelectorAll('*'));
        const clonedNodes = Array.from(visibleClone.querySelectorAll('*'));
        originalNodes.forEach((node, index) => {
            if (!isVisible(node)) clonedNodes[index].remove();
        });
        element = visibleClone;
        // 使用 textContent 而不是 innerText 以获得更好的文本提取
        const text = (element.textContent || element.innerText || '').trim();
        const html = element.innerHTML || '';
        const mathHtml = extractMathHtml(element);
        
        // 执行OCR识别（如果启用）
        const ocrTexts = await extractImagesWithOCR(element);

        // 提取题目编号和标题（保留HTML以支持数学公式）
        const titleMatch = text.match(/^[\d\.]+[、．.]?\s*(.+)/);
        let title = titleMatch ? titleMatch[1].split(/\n/)[0].trim() : text.split(/\n/)[0].trim();
        
        // 提取标题的HTML版本（用于包含数学公式）
        let titleHtml = html;
        // 尝试提取标题部分的HTML
        const titleElement = element.cloneNode(true);
        // 移除编号标记（如果存在）
        titleHtml = titleElement.innerHTML;
        
        // 如果HTML中有明显的标题容器，提取它
        const titleContainers = titleElement.querySelectorAll('.title, .question-title, [class*="title"], h1, h2, h3, h4, h5, h6, p:first-child, div:first-child');
        if (titleContainers.length > 0) {
            titleHtml = titleContainers[0].innerHTML;
        }

        // 提取选项（A、B、C、D等）
        const options = [];
        const optionHtmls = [];
        const optionPattern = /^[A-Z][\.、．]\s*(.+)$/gm;
        const optionMatches = text.matchAll(optionPattern);
        for (const match of optionMatches) {
            options.push(match[1].trim());
        }

        // 尝试从HTML中提取更精确的选项
        const optionElements = element.querySelectorAll('label, .option, [class*="option"], li');
        if (optionElements.length > 0) {
            options.length = 0;
            optionHtmls.length = 0;
            optionElements.forEach(optEl => {
                const optText = (optEl.innerText || optEl.textContent || '').trim();
                if (optText.match(/^[A-Z][\.、．]/) && optText.length > 3) {
                    options.push(optText);
                    optionHtmls.push(optEl.innerHTML || optText);
                }
            });
        } else {
            // 如果没有找到选项元素，为每个选项创建HTML版本
            options.forEach(opt => {
                optionHtmls.push(opt);
            });
        }

        // 检测题目类型
        let type = 'unknown';
        if (text.includes('单选题') || text.includes('单选')) {
            type = 'single';
        } else if (text.includes('多选题') || text.includes('多选')) {
            type = 'multiple';
        } else if (text.includes('判断题') || text.includes('判断')) {
            type = 'judge';
        } else if (text.includes('填空题') || text.includes('填空')) {
            type = 'fill';
        } else if (text.includes('简答题') || text.includes('简答')) {
            type = 'essay';
        }

        // 提取答案（如果可见）
        let answer = '';
        const answerElements = Array.from(element.querySelectorAll('.answer, .right-answer, [class~="answer"]')).filter(isVisible);
        if (answerElements.length > 0) {
            answer = Array.from(answerElements).map(el => el.textContent.trim()).join(', ');
        }

        // 合并OCR文本到题目文本中
        let finalTitle = title || text.substring(0, 200);
        if (Object.keys(ocrTexts).length > 0) {
            const ocrTextArray = Object.values(ocrTexts).filter(t => t && t.trim());
            if (ocrTextArray.length > 0) {
                finalTitle += '\n[图片文字识别：' + ocrTextArray.join(' | ') + ']';
            }
        }

        return {
            number: number,
            title: finalTitle,
            titleHtml: titleHtml || html,
            options: options,
            optionHtmls: optionHtmls,
            type: type,
            answer: answer,
            content: text,
            html: html,
            mathHtml: mathHtml,
            ocrTexts: ocrTexts
        };
    }

    // 清理文本，移除控制字符
    function cleanText(text) {
        if (!text) return '';
        return String(text)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\u200B/g, '') // 移除零宽空格
            .replace(/\uFEFF/g, '') // 移除BOM
            .trim();
    }

    // 只保留排版、图片和 MathML；移除事件、样式及可执行链接。
    function escapeHtml(text, preserveMath = false) {
        if (!text) return '';
        const div = document.createElement('div');
        if (!preserveMath) {
            div.textContent = String(text);
            return div.innerHTML;
        }
        const parsed = new DOMParser().parseFromString(String(text), 'text/html');
        const root = parsed.body;
        const blocked = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link',
            'meta', 'base', 'form', 'input', 'button', 'svg', 'video', 'audio', 'template']);
        const allowed = new Set(['div', 'p', 'span', 'br', 'b', 'strong', 'i', 'em', 'u',
            'sub', 'sup', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
            'img', 'math', 'mrow', 'mi', 'mo', 'mn', 'mfrac', 'msqrt', 'mroot', 'msup',
            'msub', 'msubsup', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd',
            'mtext', 'semantics', 'annotation']);
        for (const node of Array.from(root.querySelectorAll('*'))) {
            const tag = node.tagName.toLowerCase();
            if (blocked.has(tag)) { node.remove(); continue; }
            for (const attr of Array.from(node.attributes)) {
                const name = attr.name.toLowerCase();
                const imageAttr = tag === 'img' && ['src', 'alt', 'width', 'height'].includes(name);
                const mathAttr = ['display', 'mathvariant', 'encoding', 'colspan', 'rowspan'].includes(name);
                if (!imageAttr && !mathAttr) node.removeAttribute(attr.name);
            }
            if (tag === 'img') {
                try {
                    const src = new URL(node.getAttribute('src') || '', window.location.href);
                    if (!['http:', 'https:'].includes(src.protocol) &&
                        !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src.href)) node.remove();
                    else node.setAttribute('src', src.href);
                } catch (_) { node.remove(); }
            }
            if (!allowed.has(tag)) node.replaceWith(...node.childNodes);
        }
        return root.innerHTML;
    }

    // 处理数学公式，转换为可显示的格式
    function processMathContent(html) {
        if (!html) return '';
        
        // 保留MathML
        let processed = html.replace(/<math[^>]*>[\s\S]*?<\/math>/gi, (match) => {
            return match; // 保留MathML
        });
        
        // 保留数学公式图片
        processed = processed.replace(/<img([^>]*src=["']([^"']*math[^"']*|formula[^"']*)["'][^>]*)>/gi, (match, attrs) => {
            return match; // 保留数学图片
        });
        
        // 处理LaTeX格式 ($...$ 或 $$...$$)
        processed = processed.replace(/\$\$([^\$]+)\$\$/g, '<div class="math-display">$$$1$$</div>');
        processed = processed.replace(/\$([^\$]+)\$/g, '<span class="math-inline">$$$1$$</span>');
        
        return processed;
    }

    // 导出为Word格式
    async function exportToWord(questions) {
        try {
            const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;

            const doc = new Document({
                sections: [{
                    properties: {},
                    children: [
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: "学习通题目提取",
                                    bold: true
                                })
                            ],
                            heading: HeadingLevel.HEADING_1,
                            alignment: AlignmentType.CENTER,
                            spacing: { after: 400 }
                        }),
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: `提取时间：${new Date().toLocaleString('zh-CN')}`
                                })
                            ],
                            alignment: AlignmentType.CENTER,
                            spacing: { after: 600 }
                        }),
                        ...questions.flatMap((q) => {
                            const elements = [
                                new Paragraph({
                                    children: [
                                        new TextRun({
                                            text: `第 ${q.number} 题`,
                                            bold: true
                                        })
                                    ],
                                    heading: HeadingLevel.HEADING_2,
                                    spacing: { before: 200, after: 200 }
                                }),
                                new Paragraph({
                                    children: [
                                        new TextRun({
                                            text: cleanText(q.title),
                                            bold: true
                                        })
                                    ],
                                    spacing: { after: 200 }
                                })
                            ];

                            // 如果有HTML版本（包含数学公式），添加说明
                            if (q.titleHtml && q.titleHtml !== q.title) {
                                // Word中数学公式可能显示为文本，但保留原始格式
                                // 可以添加注释提示包含数学公式
                            }

                            // 添加选项
                            if (q.options && q.options.length > 0) {
                                q.options.forEach((option, optIndex) => {
                                    elements.push(new Paragraph({
                                        children: [
                                            new TextRun({
                                                text: cleanText(option)
                                            })
                                        ],
                                        indent: { left: 400 },
                                        spacing: { after: 100 }
                                    }));
                                });
                            }

                            // 添加答案（如果有）
                            if (q.answer) {
                                elements.push(new Paragraph({
                                    children: [
                                        new TextRun({
                                            text: `答案：${cleanText(q.answer)}`,
                                            bold: true
                                        })
                                    ],
                                    spacing: { before: 200, after: 200 }
                                }));
                            }

                            return elements;
                        })
                    ]
                }]
            });

            const blob = await Packer.toBlob(doc);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `学习通题目_${new Date().getTime()}.docx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showMessage('Word文档导出成功！', 'success');
        } catch (error) {
            console.error('导出Word失败:', error);
            showMessage('导出Word失败: ' + error.message, 'error');
        }
    }

    // 导出为PDF格式（使用HTML转PDF避免中文乱码）
    async function exportToPDF(questions) {
        try {
            // 创建HTML内容
            const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <script>
        window.MathJax = {
            tex: {
                inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
                displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']],
                processEscapes: true,
                processEnvironments: true
            },
            options: {
                ignoreHtmlClass: 'tex2jax_ignore',
                processHtmlClass: 'tex2jax_process'
            }
        };
    </script>
    <script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
    <style>
        body {
            font-family: 'Microsoft YaHei', 'SimHei', 'Arial', sans-serif;
            padding: 40px;
            line-height: 1.6;
            color: #333;
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .title {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 10px;
        }
        .timestamp {
            font-size: 12px;
            color: #666;
        }
        .question {
            margin-bottom: 30px;
            page-break-inside: avoid;
        }
        .question-number {
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 10px;
            color: #2196F3;
        }
        .question-title {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 10px;
            line-height: 1.8;
        }
        .options {
            margin-left: 20px;
            margin-bottom: 10px;
        }
        .option {
            margin-bottom: 8px;
            line-height: 1.6;
        }
        .answer {
            margin-top: 10px;
            padding: 8px;
            background-color: #e8f5e9;
            border-left: 3px solid #4CAF50;
            font-weight: bold;
        }
        .ocr-text {
            margin-top: 8px;
            padding: 6px;
            background-color: #fff3e0;
            border-left: 3px solid #FF9800;
            font-size: 12px;
            color: #666;
            font-style: italic;
        }
        .math-inline, .math-display {
            margin: 5px 0;
        }
        .math-display {
            text-align: center;
            margin: 10px 0;
        }
        math {
            font-size: 1.1em;
        }
        img[src*="math"], img[alt*="公式"], img[class*="math"], img[class*="formula"] {
            max-width: 100%;
            height: auto;
            vertical-align: middle;
        }
        @media print {
            body { padding: 20px; }
            .question { page-break-inside: avoid; }
            .math-display { page-break-inside: avoid; }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title">学习通题目提取</div>
        <div class="timestamp">提取时间：${new Date().toLocaleString('zh-CN')}</div>
    </div>
    ${questions.map(q => {
        // 处理题目标题（支持数学公式）
        let titleContent = '';
        if (q.titleHtml && q.titleHtml !== cleanText(q.title)) {
            // 使用HTML版本以保留数学公式
            titleContent = processMathContent(escapeHtml(q.titleHtml, true)).replace(/\n/g, '<br>');
        } else {
            titleContent = escapeHtml(cleanText(q.title)).replace(/\n/g, '<br>');
        }
        
        // 处理选项（支持数学公式）
        let optionsContent = '';
        if (q.options && q.options.length > 0) {
            optionsContent = q.options.map((opt, idx) => {
                let optContent = '';
                if (q.optionHtmls && q.optionHtmls[idx] && q.optionHtmls[idx] !== cleanText(opt)) {
                    optContent = processMathContent(escapeHtml(q.optionHtmls[idx], true)).replace(/\n/g, '<br>');
                } else {
                    optContent = escapeHtml(cleanText(opt)).replace(/\n/g, '<br>');
                }
                return `<div class="option tex2jax_process">${optContent}</div>`;
            }).join('');
        }
        
        // 处理答案
        let answerContent = '';
        if (q.answer) {
            answerContent = escapeHtml(cleanText(q.answer)).replace(/\n/g, '<br>');
        }
        
        // 处理OCR文本（如果存在）
        let ocrContent = '';
        if (q.ocrTexts && Object.keys(q.ocrTexts).length > 0) {
            const ocrTextArray = Object.values(q.ocrTexts).filter(t => t && t.trim());
            if (ocrTextArray.length > 0) {
                ocrContent = `<div class="ocr-text">📷 图片识别文字：${escapeHtml(ocrTextArray.join(' | '))}</div>`;
            }
        }
        
        return `
        <div class="question">
            <div class="question-number">第 ${q.number} 题</div>
            <div class="question-title tex2jax_process">${titleContent}</div>
            ${ocrContent}
            ${optionsContent ? `<div class="options">${optionsContent}</div>` : ''}
            ${answerContent ? `<div class="answer">答案：${answerContent}</div>` : ''}
        </div>
        `;
    }).join('')}
</body>
</html>`;

            // 使用Blob创建HTML文件，然后使用浏览器打印功能
            const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            
            // 打开新窗口显示HTML内容
            const printWindow = window.open(url, '_blank');
            
            if (printWindow) {
                printWindow.opener = null;
                printWindow.onload = function() {
                    // 等待MathJax加载和渲染完成
                    const waitForMathJax = () => {
                        if (printWindow.MathJax && printWindow.MathJax.typesetPromise) {
                            printWindow.MathJax.typesetPromise().then(() => {
                                setTimeout(() => {
                                    printWindow.print();
                                    showMessage('PDF导出：在打印对话框中选择"另存为PDF"', 'info');
                                    setTimeout(() => {
                                        printWindow.close();
                                        URL.revokeObjectURL(url);
                                    }, 3000);
                                }, 500);
                            }).catch(() => {
                                // MathJax渲染失败，直接打印
                                setTimeout(() => {
                                    printWindow.print();
                                    showMessage('PDF导出：在打印对话框中选择"另存为PDF"', 'info');
                                    setTimeout(() => {
                                        printWindow.close();
                                        URL.revokeObjectURL(url);
                                    }, 3000);
                                }, 500);
                            });
                        } else {
                            // MathJax尚未加载，等待一段时间后重试
                            setTimeout(() => {
                                if (Date.now() - startTime < 10000) { // 最多等待10秒
                                    waitForMathJax();
                                } else {
                                    // 超时，直接打印
                                    printWindow.print();
                                    showMessage('PDF导出：在打印对话框中选择"另存为PDF"', 'info');
                                    setTimeout(() => {
                                        printWindow.close();
                                        URL.revokeObjectURL(url);
                                    }, 3000);
                                }
                            }, 500);
                        }
                    };
                    const startTime = Date.now();
                    waitForMathJax();
                };
            } else {
                // 如果弹窗被阻止，提供下载HTML文件作为备用
                const a = document.createElement('a');
                a.href = url;
                a.download = `学习通题目_${new Date().getTime()}.html`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                showMessage('已下载HTML文件，请用浏览器打开并打印为PDF', 'info');
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }

        } catch (error) {
            console.error('导出PDF失败:', error);
            showMessage('PDF导出失败: ' + error.message + '，请尝试使用Word导出', 'error');
        }
    }

    // 显示消息提示
    function showMessage(message, type = 'info') {
        const msgDiv = document.createElement('div');
        msgDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            background: ${type === 'success' ? '#4caf50' : type === 'error' ? '#f44336' : '#2196f3'};
            color: white;
            border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            z-index: 100000;
            font-size: 14px;
            font-family: Arial, sans-serif;
            animation: slideIn 0.3s ease-out;
        `;
        msgDiv.textContent = message;
        document.body.appendChild(msgDiv);

        setTimeout(() => {
            msgDiv.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => {
                if (msgDiv.parentNode) {
                    msgDiv.parentNode.removeChild(msgDiv);
                }
            }, 300);
        }, 3000);
    }

    // 创建控制面板
    function createControlPanel() {
        // 移除已存在的面板
        const existingPanel = document.getElementById('cx-question-extractor-panel');
        if (existingPanel) {
            existingPanel.remove();
        }

        const panel = document.createElement('div');
        panel.id = 'cx-question-extractor-panel';
        panel.style.cssText = `
            position: fixed;
            top: 100px;
            right: 20px;
            width: 200px;
            background: white;
            border: 2px solid #4CAF50;
            border-radius: 8px;
            padding: 15px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            z-index: 99999;
            font-family: Arial, sans-serif;
        `;

        const title = document.createElement('div');
        title.textContent = '题目提取工具';
        title.style.cssText = `
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 15px;
            color: #333;
            text-align: center;
            border-bottom: 1px solid #eee;
            padding-bottom: 10px;
        `;
        panel.appendChild(title);

        // OCR开关
        const ocrToggle = document.createElement('div');
        ocrToggle.style.cssText = `
            margin-bottom: 10px;
            padding: 8px;
            background: #f5f5f5;
            border-radius: 4px;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        `;
        const ocrLabel = document.createElement('label');
        ocrLabel.textContent = '🔍 OCR识别';
        ocrLabel.style.cssText = 'cursor: pointer; flex: 1;';
        const ocrCheckbox = document.createElement('input');
        ocrCheckbox.type = 'checkbox';
        ocrCheckbox.checked = ocrEnabled;
        ocrCheckbox.style.cssText = 'cursor: pointer;';
        ocrLabel.appendChild(ocrCheckbox);
        ocrToggle.appendChild(ocrLabel);
        ocrCheckbox.onchange = () => {
            ocrEnabled = ocrCheckbox.checked;
            GM_setValue(OCR_ENABLED_KEY, ocrEnabled);
            GM_setValue(STORAGE_KEY, null);
            extractedQuestions = [];
            countInfo.textContent = 'OCR设置已变更，请重新提取';
            showMessage(ocrEnabled ? 'OCR已启用' : 'OCR已禁用', 'info');
        };
        panel.appendChild(ocrToggle);

        const extractBtn = document.createElement('button');
        extractBtn.textContent = '📋 提取题目';
        extractBtn.style.cssText = `
            width: 100%;
            padding: 10px;
            margin-bottom: 10px;
            background: #2196F3;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;
        extractBtn.onmouseover = () => extractBtn.style.background = '#1976D2';
        extractBtn.onmouseout = () => extractBtn.style.background = '#2196F3';
        panel.appendChild(extractBtn);

        const wordBtn = document.createElement('button');
        wordBtn.textContent = '📄 导出Word';
        wordBtn.style.cssText = `
            width: 100%;
            padding: 10px;
            margin-bottom: 10px;
            background: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;
        wordBtn.onmouseover = () => wordBtn.style.background = '#45a049';
        wordBtn.onmouseout = () => wordBtn.style.background = '#4CAF50';
        panel.appendChild(wordBtn);

        const pdfBtn = document.createElement('button');
        pdfBtn.textContent = '📑 导出PDF';
        pdfBtn.style.cssText = `
            width: 100%;
            padding: 10px;
            margin-bottom: 10px;
            background: #FF9800;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;
        pdfBtn.onmouseover = () => pdfBtn.style.background = '#F57C00';
        pdfBtn.onmouseout = () => pdfBtn.style.background = '#FF9800';
        panel.appendChild(pdfBtn);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕ 关闭';
        closeBtn.style.cssText = `
            width: 100%;
            padding: 8px;
            background: #f44336;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        `;
        closeBtn.onmouseover = () => closeBtn.style.background = '#da190b';
        closeBtn.onmouseout = () => closeBtn.style.background = '#f44336';
        panel.appendChild(closeBtn);

        const countInfo = document.createElement('div');
        countInfo.id = 'cx-question-count';
        countInfo.style.cssText = `
            margin-top: 10px;
            padding: 8px;
            background: #f5f5f5;
            border-radius: 4px;
            font-size: 12px;
            text-align: center;
            color: #666;
        `;
        countInfo.textContent = '正在自动提取...';
        panel.appendChild(countInfo);

        let extractedQuestions = getStoredQuestions() || [];
        let extracting = false;
        countInfo.textContent = extractedQuestions.length
            ? `当前页面缓存 ${extractedQuestions.length} 道题目` : '等待提取当前页面题目';

        async function runExtraction(notify = false) {
            if (extracting) return [];
            extracting = true;
            [extractBtn, wordBtn, pdfBtn, ocrCheckbox].forEach(button => { button.disabled = true; });
            const source = cacheIdentity();
            countInfo.textContent = '正在提取当前页面...';
            try {
                const questions = await extractQuestions();
                if (source !== cacheIdentity()) {
                    extractedQuestions = [];
                    countInfo.textContent = '页面已切换，请在当前页面重新提取';
                    return [];
                }
                extractedQuestions = questions;
                saveQuestions(questions, source);
                countInfo.textContent = questions.length ? `已提取 ${questions.length} 道题目` : '未找到题目，请确认题目已加载';
                if (notify) showMessage(countInfo.textContent, questions.length ? 'success' : 'error');
                return questions;
            } catch (error) {
                extractedQuestions = [];
                countInfo.textContent = '提取失败，请重试';
                showMessage('提取失败: ' + error.message, 'error');
                return [];
            } finally {
                extracting = false;
                [extractBtn, wordBtn, pdfBtn, ocrCheckbox].forEach(button => { button.disabled = false; });
            }
        }

        // 每次导出重新读取当前页面，避免 SPA 导航或题目更新后导出旧内容。
        setTimeout(() => runExtraction(), 2000);
        extractBtn.onclick = () => runExtraction(true);
        wordBtn.onclick = async () => {
            const questions = await runExtraction(true);
            if (questions.length) await exportToWord(questions);
        };
        pdfBtn.onclick = async () => {
            const questions = await runExtraction(true);
            if (questions.length) await exportToPDF(questions);
        };

        closeBtn.onclick = () => {
            panel.style.display = 'none';
        };

        document.body.appendChild(panel);
    }

    // 在 Node 中暴露逻辑供虚构 DOM 回归测试，浏览器仍直接运行。
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { cleanText, escapeHtml, cacheIdentity, getStoredQuestions,
            saveQuestions, extractQuestions, extractQuestionData, isVisible };
        return;
    }
    ocrEnabled = GM_getValue(OCR_ENABLED_KEY, false);

    // 添加样式动画
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(400px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        @keyframes slideOut {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(400px);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);

    // 页面加载完成后创建控制面板
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createControlPanel);
    } else {
        createControlPanel();
    }

    // 监听页面变化（SPA应用）
    const observer = new MutationObserver(() => {
        const panel = document.getElementById('cx-question-extractor-panel');
        if (!panel) {
            createControlPanel();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

})();


