const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const config = require('./config');
const utils = require('./utils');
const colors = require('colors');

class YuqueCrawler {
    constructor(options = {}) {
        this.browser = null;
        this.page = null;
        this.onProgress = options.onProgress || (() => {});
        this.onLog = options.onLog || console.log;
    }

    async init() {
        this.onLog('正在启动浏览器...'.cyan);
        this.browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                `--window-size=${config.windowSize}`
            ],
            defaultViewport: null
        });

        this.page = await this.browser.newPage();
        await this.page.setUserAgent(config.userAgent);

        if (config.cookie) {
            this.onLog('注入 Cookie...'.green);
            const cookies = config.cookie.split(';').map(pair => {
                const [name, ...value] = pair.trim().split('=');
                return { name: name.trim(), value: value.join('=').trim(), domain: '.yuque.com' };
            });
            await this.page.setCookie(...cookies);
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.onLog('浏览器已关闭'.cyan);
        }
    }

    async fetchBookInfo() {
        this.onLog(`正在访问目标页面获取知识库信息: ${config.targetUrl}`.blue);
        await this.page.goto(config.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await utils.sleep(3000);

        const bookData = await this.page.evaluate(() => {
            if (window.appData && window.appData.book) {
                return window.appData.book;
            }
            return null;
        });

        if (!bookData) {
            throw new Error('无法获取知识库信息(window.appData.book)，请检查 URL 或 Cookie。');
        }

        return bookData;
    }

    // 使用 axios 直接调用 API，不依赖 puppeteer 页面上下文
    async fetchMarkdownApi(bookId, slug) {
        const apiUrl = `https://www.yuque.com/api/docs/${slug}?book_id=${bookId}&merge_dynamic_data=false&mode=markdown`;
        const headers = {
            'User-Agent': config.userAgent
        };
        if (config.cookie) {
            headers['Cookie'] = config.cookie;
        }

        for (let i = 0; i < config.retry; i++) {
            try {
                const response = await axios.get(apiUrl, { 
                    headers, 
                    timeout: config.timeout 
                });
                
                if (response.data && response.data.data) {
                    return response.data.data.sourcecode || '';
                }
                throw new Error('API 返回数据格式异常');
            } catch (error) {
                if (i === config.retry - 1) throw error;
                await utils.sleep(config.sleepBetweenRetry);
            }
        }
    }

    async processDocument(bookId, slug, savePath) {
        let markdownContent = '';

        try {
            // 使用 axios 获取内容
            const sourceCode = await this.fetchMarkdownApi(bookId, slug);
            markdownContent = sourceCode;

            if (!markdownContent) {
                // 如果内容为空，返回 false 表示未保存
                return false;
            }
        } catch (e) {
            // 获取失败视为未保存
            return false;
        }

        // 2. 处理图片
        const mdDir = path.dirname(savePath);
        const imagesDir = path.join(mdDir, 'images');
        
        const mdImgRegex = /!\[([^\]]*)\]\((https?[^)]+)\)/g;
        const htmlImgRegex = /<img[^>]*?src=["'](https?[^"']+)["']/g;
        
        const imagesToDownload = [];
        let match;
        while ((match = mdImgRegex.exec(markdownContent)) !== null) {
            imagesToDownload.push({ url: match[2], isHtml: false });
        }
        while ((match = htmlImgRegex.exec(markdownContent)) !== null) {
            imagesToDownload.push({ url: match[1], isHtml: true });
        }

        const uniqueImages = [...new Set(imagesToDownload.map(i => i.url))];
        
        if (uniqueImages.length > 0) {
            utils.ensureDir(imagesDir);
            for (const imgUrl of uniqueImages) {
                const filename = utils.getLocalFilename(imgUrl);
                const localAbsPath = path.join(imagesDir, filename);
                const localRelPath = `images/${filename}`;

                try {
                    await utils.downloadFile(imgUrl, localAbsPath);
                    markdownContent = markdownContent.split(imgUrl).join(localRelPath);
                } catch (e) {
                    // 图片下载失败，暂不中断流程
                }
            }
        }

        // 3. 保存文件
        utils.ensureDir(mdDir);
        fs.writeFileSync(savePath, markdownContent);
        return true;
    }

    async start() {
        // 动态引入 p-limit
        const pLimit = (await import('p-limit')).default;
        const limit = pLimit(config.concurrency || 5);

        await this.init();

        try {
            const bookData = await this.fetchBookInfo();
            // 获取完信息后可以关闭浏览器，因为后续 API 调用走 axios
            await this.close(); 
            this.browser = null; // 置空防止 finally 再次关闭

            const bookId = bookData.id;
            const bookName = utils.sanitizeName(bookData.name);
            const toc = bookData.toc || [];

            this.onLog(`成功识别知识库: [${bookName}] (ID: ${bookId})`.green.bold);
            this.onLog(`目录条目数: ${toc.length}`.blue);
            this.onLog(`并发数: ${config.concurrency}`.magenta);

            const bookRootDir = path.join(config.outputRoot, bookName);
            utils.ensureDir(bookRootDir);

            // 解析目录结构
            const nodeMap = {};
            toc.forEach(item => {
                nodeMap[item.uuid] = { ...item };
            });

            const getPath = (uuid) => {
                const node = nodeMap[uuid];
                if (!node) return '';
                const safeTitle = utils.sanitizeName(node.title);
                if (!node.parent_uuid) return safeTitle;
                return path.join(getPath(node.parent_uuid), safeTitle);
            };

            
            // 筛选出需要下载的文档
            const docItems = toc.filter(item => item.url && item.url.length > 0);
            const totalDocs = docItems.length;
            let completedCount = 0;

            // 初始化进度条
            this.onProgress('start', totalDocs);

            // 构建任务列表
            const tasks = [];
            // 用于记录每个 doc 是否成功保存
            const docStatusMap = new Map(); // uuid -> boolean

            for (const item of toc) {
                const itemPath = getPath(item.uuid);
                const isDoc = item.url && item.url.length > 0;
                
                if (isDoc) {
                    const fileName = `${itemPath}.md`;
                    const absFilePath = path.join(bookRootDir, fileName);

                    // 添加并发任务
                    tasks.push(limit(async () => {
                        try {
                            const saved = await this.processDocument(bookId, item.url, absFilePath);
                            docStatusMap.set(item.uuid, saved);
                        } catch (error) {
                            this.onLog(`\n[Error] ${item.title}: ${error.message}`.red);
                            docStatusMap.set(item.uuid, false);
                        } finally {
                            completedCount++;
                            this.onProgress('update', completedCount, { 
                                file: item.title, // 显示当前完成的文件
                                status: 'Done' 
                            });
                        }
                    }));
                } else {
                    // 非文档节点，确保目录存在
                    const dirPath = path.join(bookRootDir, itemPath);
                    utils.ensureDir(dirPath);
                }
            }

            // 等待所有任务完成
            await Promise.all(tasks);

            this.onProgress('stop');

            // --- 第二次遍历：生成 SUMMARY.md ---
            const summaryLines = ['# Summary\n'];
            for (const item of toc) {
                const itemPath = getPath(item.uuid);
                const isDoc = item.url && item.url.length > 0;
                
                const depth = itemPath.split(path.sep).length - 1;
                const indent = '  '.repeat(depth);

                // 判断是否应该生成链接
                // 只有当它是 Doc 并且成功保存了文件时，才生成链接
                const saved = docStatusMap.get(item.uuid);
                const shouldLink = isDoc && saved;

                if (shouldLink) {
                    const fileName = `${itemPath}.md`;
                    const relLink = fileName.split(path.sep).join('/');
                    summaryLines.push(`${indent}* [${item.title}](${encodeURI(relLink)})`);
                } else {
                    // 否则只作为纯文本节点
                    summaryLines.push(`${indent}* ${item.title}`);
                }
            }

            fs.writeFileSync(path.join(bookRootDir, 'SUMMARY.md'), summaryLines.join('\n'));
            this.onLog(`SUMMARY.md 已生成`.green);

        } catch (error) {
            this.onLog(`全局错误: ${error.message}`.red);
        } finally {
            if (this.browser) {
                await this.close();
            }
        }
    }
}

module.exports = YuqueCrawler;
