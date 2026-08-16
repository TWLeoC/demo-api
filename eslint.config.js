const js = require('@eslint/js')

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
      // builder.js 故意用 \x00-\x1f 過濾出單機控制碼注入，這是刻意的安全性程式碼
      'no-control-regex': 'off',
      // lineService.js/line.js 的訊息樣板故意用全形空白（U+3000）排版，不是打錯字
      'no-irregular-whitespace': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'test/'],
  },
]
