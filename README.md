# 学习通题目提取工具

[![Tests](https://github.com/W-sir0/chaoxing-question-extractor/actions/workflows/tests.yml/badge.svg)](https://github.com/W-sir0/chaoxing-question-extractor/actions/workflows/tests.yml)
![JavaScript](https://img.shields.io/badge/JavaScript-userscript-F7DF1E)
![Version](https://img.shields.io/badge/version-1.2.0-blue)

A Tampermonkey userscript for extracting visible Chaoxing questions and exporting study notes.

将学习通页面上已显示的题目整理成复习资料，支持 Word 导出、浏览器打印为 PDF，以及可选的图片 OCR。项目原仓库名为 `-`，现已整理为可安装的 `.user.js` 脚本与可复现的测试。

## 安装与使用

1. 在浏览器中安装 [Tampermonkey 官方扩展](https://www.tampermonkey.net/)。
2. 打开 [脚本安装链接](https://raw.githubusercontent.com/W-sir0/chaoxing-question-extractor/main/chaoxing-question-extractor.user.js)，在扩展中查看并安装。若浏览器只显示源代码，新建用户脚本并粘贴完整内容。
3. 打开学习通题目页面，等待内容加载，点击右侧面板的“提取题目”。
4. 核对提取数量后，选择“导出 Word”或“导出 PDF”。PDF 会打开浏览器打印页面，请选择“另存为 PDF”。

更新旧版时只保留一个启用的脚本，避免出现多个控制面板。脚本运行范围为 `chaoxing.com` 子域名页面；使用前需已正常登录并有权限查看相应内容。

## 功能与边界

| 功能 | 行为 |
|---|---|
| 题目与选项 | 按已识别的题目容器提取，未知页面明确返回“未找到题目” |
| 答案 | 只整理页面上已经显示的答案，不请求隐藏答案接口 |
| Word | 导出题干、选项和可见答案的文字；复杂公式与原图不保证完整保留 |
| PDF | 通过浏览器打印保留支持的 MathML、公式图片和排版；弹窗被阻止时下载 HTML |
| OCR | 默认关闭，可识别题目图片中的中英文，结果需要人工核对 |
| 缓存 | 按页面 URL、SPA 路由与 OCR 设置核对，一小时后失效；每次导出重新读取当前页 |

学校页面结构和跨域 iframe 可能不同，不能保证所有课程界面兼容。跨域题目应在有权限的题目框架页面中运行脚本；未识别页面可以提交脱敏后的虚构结构案例。当前回归测试使用虚构 DOM，没有使用真实学习通账号进行平台兼容性验证。

## 数据与依赖

脚本不提供题目上传服务或答题提交功能。题目缓存位于用户脚本扩展本地存储中。启用 OCR 或打印数学公式时，会加载第三方静态依赖、识别模型或原页面图片；图片下载仍受浏览器和站点权限约束。

运行时使用 `docx`、`Tesseract.js`，打印页使用 MathJax。已移除未使用的 jsPDF、AutoTable 和额外跨域请求授权。导出的题目 HTML 会保留必要排版与 MathML，并去除脚本、事件属性和可执行链接。请只整理自己有权保存的学习资料。

## 开发与测试

需要 Node.js 24+。开发测试依赖 jsdom，浏览器安装脚本时不需要 npm。

```bash
git clone https://github.com/W-sir0/chaoxing-question-extractor.git
cd chaoxing-question-extractor
npm ci
npm run check
npm test
```

测试覆盖：跨页面/跨路由缓存隔离、过期缓存、HTML 清理、MathML 保留、隐藏内容排除、嵌套题目去重，以及切换页面后通过导出按钮重新提取当前题目。

## 常见问题

- **未找到题目**：先确认页面内容已经加载且属于支持的题目容器；脚本不会将整个页面冒充一道题。
- **PDF 没有自动下载**：使用打印窗口的“另存为 PDF”；如果弹窗被拦截，打开下载的 HTML 再打印。
- **Word 中公式变为文字**：Word 导出目前以文字为主，可尝试 PDF 并核对公式。
- **OCR 失败**：检查模型依赖及图片能否加载；可以关闭 OCR，先提取文字部分。

提交问题时请提供浏览器/扩展版本、脚本版本与虚构的最小复现，不上传真实题目、姓名、学号、账号凭证或未脱敏截图。
