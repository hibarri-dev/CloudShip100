FROM node:18-alpine

RUN mkdir -p /usr/src/node-app && chown -R node:node /usr/src/node-app

WORKDIR /usr/src/node-app

COPY package.json yarn.lock ./

USER node

RUN yarn config set network-timeout 600000 \
  && yarn install --pure-lockfile --production --network-concurrency 4 --ignore-engines

COPY --chown=node:node . .

EXPOSE 3000

CMD ["yarn", "start"]
