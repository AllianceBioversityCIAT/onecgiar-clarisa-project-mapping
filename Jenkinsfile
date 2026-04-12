pipeline {
  agent any
  environment {
    APP_BUILD_VERSION = sh(script: 'date +%s', returnStdout: true).trim()
  }
  stages {
    stage('Verify tooling') {
      steps {
        slackSend color: 'black', message: 'PRMS Projects Registry build process is started'
        sh '''
          docker version
          docker info
          docker compose version
        '''
      }
    }
    stage('Copy Env') {
      steps {
        sh '''
          cp /var/lib/jenkins/workspace/Environments/w3/back-end/.env api/
        '''
      }
    }
    stage('Clean up') {
      steps {
        sh 'docker system prune -a -f'
      }
    }
    stage('Build API') {
      steps {
        sh 'docker compose build api'
      }
    }
    stage('Build Web') {
      steps {
        sh 'docker compose build web'
      }
    }
    stage('Start containers') {
      steps {
        sh 'docker compose up -d --no-color --wait'
        sh 'docker compose ps'
      }
    }
  }
  post {
    always {
      slackSend color: 'black', message: 'PRMS Projects Registry build process is finished'
    }
    success {
      slackSend color: 'good', message: 'PRMS Projects Registry build process is done successfully!'
    }
    failure {
      slackSend color: 'bad', message: 'PRMS Projects Registry build process is done with failure'
      writeFile file: 'jenkins_console_output.txt', text: currentBuild.rawBuild.logFile.text
      sh 'sed -ri "s/\\x1b\\[8m.*?\\x1b\\[0m//g" jenkins_console_output.txt'
      slackUploadFile filePath: 'jenkins_console_output.txt', initialComment: 'here is the log file'
    }
  }
}
