import gulp                 from 'gulp'
import util 				from 'gulp-util'
import notifier 			from 'node-notifier'
import path 				from 'path'
import child 				from 'child_process'
import reload 				from 'gulp-livereload'
import yarn 				from 'gulp-yarn'

const currentdir			= __dirname

function notify(title,subtitle,message,timeout,type){
	var icon=''
	switch (type){
	case 'fail':
	case 'error':
		icon='fail.png'
		break
	case 'start':
		icon='start.png'
		break
	case 'success':
	case 'ok':
        icon='ok.png'
        break
    default:
        icon='fail.png'
	}
	notifier.notify({
		title: title,
		subtitle: subtitle,
		message:  message,
		timeout: timeout,
		icon: path.join(currentdir, '/assets/buildicons/',icon),
		//contentImage: path.join(currentdir,'/assets/buildicons/', image)
	})
}

gulp.task('server:build:linux', function() {
	var build = child.spawnSync('go', [
		'build', 'github.com/gbozo/kuberneticos'
	], {
		env: {
			GOOS: 'linux',
			GOARCH: 'amd64',
			GOPATH: currentdir,
			GOBIN: path.join(currentdir,'bin')
		}
	})
	if (build.stderr.length) {
		var lines = build.stderr.toString().split('\n').filter(function(line) {
			return line.length
		})
		for (var l in lines)
			util.log(util.colors.red('Error (go install): ' + lines[l]))
		notify('Error (go install)','',lines, 30,'error')
	}
	return build
})

gulp.task('server:build', function() {
	var build = child.spawnSync('go', [
		'install', 'github.com/gbozo/kuberneticos'
	], {
		env: {
			GOPATH: currentdir,
			GOBIN: path.join(currentdir,'bin')
		}
	})
	if (build.stderr.length) {
		var lines = build.stderr.toString().split('\n').filter(function(line) {
			return line.length
		})
		for (var l in lines)
			util.log(util.colors.red('Error (go install): ' + lines[l]))
		notify('Error (go install)','',lines, 30,'error')
	}
	return build
})

/* Restart application server. */
gulp.task('server:spawn',gulp.series(['server:build']) , function() {
	if (server)
		server.kill()

	/* Spawn application server */
	server = child.spawn('bin/kuberneticos.exe')

	/* Trigger reload upon server start */
	server.stdout.once('data', function() {
		reload.reload('/')
	})

	/* Pretty print server log output */
	server.stdout.on('data', function(data) {
		var lines = data.toString().split('\n')
		for (var l in lines)
			if (lines[l].length)
				util.log(util.colors.gray('Backend |'+lines[l]))
	})

	/* Print errors to stdout */
	server.stderr.on('data', function(data) {
		util.log(util.colors.gray('Backend |'+data.toString()))
	})
})

/* Watch source for changes and restart application server. */
gulp.task('server:watch', function() {

	/* Restart application server */
	gulp.watch([
		// 'assets/config/*.*',
		// 'assets/i18n/*.properties',
		'src/github.com/gbozo/kuberneticos/**/*.go',
		'!src/github.com/gbozo/kuberneticos/vendor/**/*.go'
	], 'server:spawn')

})
gulp.task('yarn', function() {
    return gulp.src(['./package.json'])
        .pipe(yarn());
});
 
gulp.task('build', 
gulp.series(['server:build'])
)

gulp.task('watch',function() {
	reload.listen()
	return gulp.parallel(['server:spawn','server:watch'])
})


gulp.task('default', gulp.series(['watch']))
