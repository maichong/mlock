FROM node:14.5.0-alpine3.11

RUN npm install -g mlock-server@0.1.8

CMD mlock-server

EXPOSE 12340
