'use strict';
const path=require('path'),webpack=require('webpack');
webpack({mode:'production',entry:path.join(__dirname,'entry.js'),output:{path:path.resolve(__dirname,'../../src/vendor'),filename:'schema-engine-libs.js',library:{type:'commonjs2'}},target:'webworker',devtool:false,optimization:{minimize:true}},(error,stats)=>{if(error||stats.hasErrors()){console.error(error||stats.toJson().errors);process.exitCode=1;return;}console.log(stats.toString({all:false,assets:true}));});
