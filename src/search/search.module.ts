import { Module } from '@nestjs/common';
import SearchController from './search.controller';

@Module({
    imports: [],
    controllers: [SearchController]
})
export default class SearchModule {
}