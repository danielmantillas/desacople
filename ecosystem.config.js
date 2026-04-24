module.exports = {
  apps: [{
    name: 'desacople',
    script: './index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '150M'
  }]
};
