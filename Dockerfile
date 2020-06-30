FROM maichong/node:12.13.0

RUN npm install -g mlock-server@0.1.2

CMD mlock-server

EXPOSE 12340
