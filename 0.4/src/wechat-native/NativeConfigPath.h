#pragma once

// The loader writes this local-only pointer beside its DLL. It is never shipped.
static std::filesystem::path NativeConfigPath() {
    wchar_t name[32768]{};HMODULE self=nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&NativeConfigPath),&self);
    GetModuleFileNameW(self,name,32768);auto root=std::filesystem::path(name).parent_path();
    try {
        std::ifstream input(root/L"backend-config.path",std::ios::binary);std::string value;std::getline(input,value);
        if(!value.empty()&&value.back()=='\r')value.pop_back();
        const auto file=std::filesystem::u8path(value);
        if(file.is_absolute()&&file.filename()==L"native-send.private.json"&&std::filesystem::is_regular_file(file))return file;
    } catch(...) {}
    return root/L"native-send.unconfigured.json";
}
