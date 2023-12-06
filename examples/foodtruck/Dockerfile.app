FROM node:20

ADD . /app
WORKDIR /app
RUN npm install
