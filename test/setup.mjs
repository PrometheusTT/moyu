// Keep existing Chinese golden fixtures independent of the CI host locale.
process.env.MOYU_LANG = 'zh';
process.env.LC_ALL = 'zh_CN.UTF-8';
process.env.LC_MESSAGES = 'zh_CN.UTF-8';
process.env.LANG = 'zh_CN.UTF-8';
