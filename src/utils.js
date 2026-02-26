const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const config = require('./config');

// 休眠函数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 确保目录存在
const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

// 生成本地文件名 (UUID)
const getLocalFilename = (url) => {
    try {
        const urlObj = new URL(url);
        let ext = path.extname(urlObj.pathname).toLowerCase();
        if (!ext || ext.length > 6) ext = '.png';
        return `${crypto.randomUUID().replace(/-/g, '')}${ext}`;
    } catch (e) {
        return `${crypto.randomUUID().replace(/-/g, '')}.png`;
    }
};

// 清理文件名
const sanitizeName = (name) => {
    return name.replace(/[\\/:*?"<>|\r\n]/g, '_').trim();
};

// 下载文件 (带重试)
const downloadFile = async (url, destPath, retryCount = config.retry) => {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
            const response = await axios({
                method: 'GET',
                url: url,
                responseType: 'stream',
                timeout: config.timeout,
                headers: {
                    'User-Agent': config.userAgent
                }
            });
            const writer = fs.createWriteStream(destPath);
            response.data.pipe(writer);
            return new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
        } catch (error) {
            if (attempt < retryCount) {
                await sleep(config.sleepBetweenRetry);
            } else {
                throw error;
            }
        }
    }
};

module.exports = {
    sleep,
    ensureDir,
    getLocalFilename,
    sanitizeName,
    downloadFile
};
