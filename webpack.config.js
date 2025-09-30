const path = require('path');

module.exports = {
    mode: 'production',
    entry: './src/index.ts',
    output: {
        path: path.resolve(__dirname, '../../../public/js'),
        filename: 'editorjs-undo.js',
        library: {
            name: 'EditorUndoManager',
            type: 'umd',
            export: 'default'
        },
    },
    module: {
        rules: [
            {
                test: /\.(ts|tsx)$/,
                use: 'babel-loader',
                exclude: /node_modules/,
            }
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
    }
};
