const YuqueCrawler = require('./src/crawler');
const cliProgress = require('cli-progress');
const colors = require('colors');

// 创建进度条实例
const progressBar = new cliProgress.SingleBar({
    format: '下载进度 |' + colors.cyan('{bar}') + '| {percentage}% || {value}/{total} Files || Current: {file}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
});

const crawler = new YuqueCrawler({
    // 日志回调
    onLog: (msg) => {
        // 如果进度条正在运行，需要先清除当前行或者在进度条上方打印，
        // 但 cli-progress 在这里处理起来比较麻烦，
        // 简单做法是只在非进度条期间打印，或者不打印详细日志
        // 这里我们选择直接 console.log，可能会打断进度条显示，
        // 所以我们在 start 和 stop 之间尽量少打印日志
        // 或者我们可以判断进度条状态
        // 简单起见，这里直接打印
        console.log(msg);
    },
    // 进度回调
    onProgress: (action, value, payload) => {
        if (action === 'start') {
            console.log('\n');
            progressBar.start(value, 0, { file: 'Starting...' });
        } else if (action === 'update') {
            progressBar.update(value, payload);
        } else if (action === 'stop') {
            progressBar.stop();
            console.log('\n');
        }
    }
});

(async () => {
    try {
        console.log(colors.rainbow('CAN: 正在初始化语雀爬虫...'));
        await crawler.start();
    } catch (err) {
        console.error('未捕获的错误:', err);
    }
})();
